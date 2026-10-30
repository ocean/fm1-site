// Tests for the zip reader, discovery's helpers and mapLimit.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { catalogueRepos, isExcluded, listForks, pushedSinceForked, searchRepos } from "./discover.mjs";
import { mapLimit } from "./github.mjs";
import { filesInZip } from "./zip.mjs";

// A zip archive of the given files, each stored or deflated (CRCs left at 0: the reader doesn't check them).
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of files) {
    const stored = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, stored);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("filesInZip", () => {
  const one = Buffer.alloc(5000, 0x41);
  const two = Buffer.from("a stored package");

  it("reads the .fwsc files, stored or deflated, and nothing else", () => {
    const archive = makeZip([
      { name: "README.txt", data: Buffer.from("hi") },
      { name: "fw/one.fwsc", data: one, deflate: true },
      { name: "two.FWSC", data: two },
      { name: "__MACOSX/fw/._one.fwsc", data: two },
    ]);
    assert.deepEqual(
      filesInZip(archive).map((file) => [file.name, file.data]),
      [["fw/one.fwsc", one], ["two.FWSC", two]],
    );
  });

  it("skips entries over the size limit", () => {
    const archive = makeZip([{ name: "big.fwsc", data: one, deflate: true }]);
    assert.deepEqual(filesInZip(archive, { maximumBytes: 1000 }), []);
  });

  it("refuses something that isn't a zip", () => {
    assert.throws(() => filesInZip(Buffer.alloc(100)), /not a zip/);
  });
});

describe("discovery", () => {
  it("takes GitHub repositories from the catalogue, once each", () => {
    const catalogue = {
      entries: [
        { name: "A", repo: "someone/a", product: "FM-1_1" },
        { name: "A again", repo: "Someone/A" },
        { name: "B", links: [{ label: "Source code", url: "https://github.com/other/b" }] },
        { name: "C", links: [{ label: "Project site", url: "https://example.com" }] },
      ],
    };
    assert.deepEqual(catalogueRepos(catalogue), [
      { repo: "someone/a", name: "A", product: "FM-1_1" },
      { repo: "other/b", name: "B", product: null },
    ]);
  });

  it("leaves out the platform's libraries, in any case", () => {
    assert.ok(isExcluded("Hugelton/Felucca-BSP"));
    assert.ok(!isExcluded("hugelton/Felucca"));
  });

  it("tells a fork that's been pushed to from a plain copy", () => {
    assert.ok(pushedSinceForked({ createdAt: "2026-10-01T00:00:00Z", pushedAt: "2026-10-02T00:00:00Z" }));
    assert.ok(!pushedSinceForked({ createdAt: "2026-10-01T00:00:00Z", pushedAt: "2026-09-30T00:00:00Z" }));
  });

  it("never adds a private repository, whatever the token can see", async () => {
    const repository = (full_name, extra = {}) => ({ repository: { full_name, fork: false, private: false, ...extra } });
    const github = {
      searchCode: async () => [repository("someone/public-fw"), repository("drew/secret-fw", { private: true })],
      graphql: async () => ({
        data: {
          repository: {
            forks: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { nameWithOwner: "someone/fork", createdAt: "2026-10-01T00:00:00Z", pushedAt: "2026-10-02T00:00:00Z", isPrivate: false },
                { nameWithOwner: "drew/secret-fork", createdAt: "2026-10-01T00:00:00Z", pushedAt: "2026-10-02T00:00:00Z", isPrivate: true },
              ],
            },
          },
        },
      }),
    };
    assert.deepEqual(await searchRepos(github, () => {}), ["someone/public-fw"]);
    const forks = await listForks(github, ["hugelton/felucca"]);
    assert.deepEqual(forks.get("hugelton/felucca").map((fork) => fork.repo), ["someone/fork"]);
  });
});

describe("mapLimit", () => {
  it("keeps the items' order and the limit", async () => {
    let running = 0;
    let most = 0;
    const results = await mapLimit([30, 10, 20, 0, 5], 2, async (delay, index) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, delay));
      running--;
      return index * 2;
    });
    assert.deepEqual(results, [0, 2, 4, 6, 8]);
    assert.equal(most, 2);
  });
});
