// Tests for the source classifier, on made-up C and a pretend GitHub.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blobId,
  candidateFiles,
  classifyText,
  createSourceClassifier,
  githubRepoOf,
  hasSizeCheck,
  parseGitmodules,
} from "./source.mjs";

// Made-up update code with the same telltale parts as the real thing.
const oldCheck = `
#define OTA_LDR_HCRC 0xEBAAu
int ota_stage(void) {
    official = ota_rd16(b) == OTA_LDR_HCRC;
    if (official) { /* the official loader writes the head: it must equal ours */
        for (i = 0; i < 0x4000u; i += 512u)
            if (!ota_memeq(b, mine, 512)) return -5;
    }
}`;
const fixedCheck = `
static int ota_boot_valid(uint32_t off, uint32_t len, uint8_t *b) { return 0; }
int ota_stage(void) { if (fl_off && !own) return ota_boot_valid(fl_off, fl_len, b); }`;
const pinnedCheck = `
#define OTA_LDR_HCRC 0xEBAAu
static int etch_ota_stock(uint32_t off, uint8_t *b) { return sha256_eq(off, b); }
int ota_stage(void) { if (official && etch_ota_stock(fl_off, b)) stock = 1; }`;
const ownLoaderOnly = `
static const char marker[] = "FELUCCA-LOADER-1";
int ota_stage(void) { return ota_restage(); }`;

describe("classifyText", () => {
  it("finds the old check", () => assert.equal(classifyText(oldCheck), "affected"));
  it("finds the fix", () => assert.equal(classifyText(fixedCheck), "fixed"));
  it("finds the fix even beside the old constants", () => assert.equal(classifyText(oldCheck + fixedCheck), "fixed"));
  it("finds the pinned V15 image", () => assert.equal(classifyText(pinnedCheck), "pinned"));
  it("finds update code without the check", () => assert.equal(classifyText(ownLoaderOnly), "update-code"));
  it("finds a rewrite's check, without the comment", () => {
    const rewrite = `#define LDR_HCRC 0xEBAA
      for (i = 0; i < 0x4000u; i += n) if (memcmp(b, mine, n)) return -7;`;
    assert.equal(classifyText(rewrite), "affected");
  });
  it("finds nothing in other code", () => assert.equal(classifyText("int main(void) { return 0; }"), null));
});

describe("hasSizeCheck", () => {
  const sizeCheck = `#define OTA_FL_LEN 0x93000u
    if (fl_len != OTA_FL_LEN)
        return -15;                /* another board's package */`;
  it("finds Felucca 1.6.1's board-size check", () => assert.equal(hasSizeCheck(oldCheck + sizeCheck), true));
  it("finds it written as a number", () => {
    assert.equal(hasSizeCheck("if (fl_len != 0x93000) return -15;"), true);
  });
  it("doesn't find it in earlier copies", () => assert.equal(hasSizeCheck(oldCheck), false));
  it("needs the board's size", () => {
    assert.equal(hasSizeCheck("#define OTA_FL_LEN 0x73000u\nif (fl_len != OTA_FL_LEN) return -15;"), false);
  });
});

describe("candidateFiles", () => {
  it("ranks the repository's own ota.c first and leaves out tests", () => {
    const tree = [
      "tests/ota_test.c",
      "firmware/stub/stub_core.h",
      "vendor/felucca/firmware/src/ota.c",
      "firmware/src/ota.c",
      "hal/fm1/fm1_update.c",
      "firmware/src/main.c",
      "lof1/firmware/src/ota.c",
      "src/ota_mock.c",
    ].map((path) => ({ path, type: "blob" }));
    assert.deepEqual(
      candidateFiles(tree).map((entry) => entry.path),
      ["firmware/src/ota.c", "lof1/firmware/src/ota.c", "hal/fm1/fm1_update.c", "vendor/felucca/firmware/src/ota.c"],
    );
  });
});

describe("submodules", () => {
  it("reads .gitmodules", () => {
    const text = `[submodule "base"]\n\tpath = base\n\turl = https://github.com/charlesvestal/fm1-base.git\n[submodule "x"]\n\turl = ../x\n\tpath = lib/x\n`;
    assert.deepEqual(parseGitmodules(text), [
      { path: "base", url: "https://github.com/charlesvestal/fm1-base.git" },
      { url: "../x", path: "lib/x" },
    ]);
  });

  it("names GitHub repositories from submodule URLs", () => {
    assert.equal(githubRepoOf("https://github.com/hugelton/felucca-bsp"), "hugelton/felucca-bsp");
    assert.equal(githubRepoOf("git@github.com:hugelton/Felucca.git"), "hugelton/Felucca");
    assert.equal(githubRepoOf("../fm1-base.git", "someone/firmware"), "someone/fm1-base");
    assert.equal(githubRepoOf("https://gitlab.com/a/b.git"), null);
  });
});

// A pretend GitHub: trees by repo@commit, files by repo@commit:path.
function fakeGitHub({ trees, files }) {
  const calls = [];
  return {
    calls,
    async rest(path) {
      calls.push(path);
      const match = /^repos\/(.+)\/git\/trees\/(\w+)\?recursive=1$/.exec(path);
      const tree = match && trees[`${match[1]}@${match[2]}`];
      return tree ? { tree, truncated: false } : null;
    },
    async raw(repo, ref, path) {
      const text = files[`${repo}@${ref}:${path}`];
      return text === undefined ? null : Buffer.from(text);
    },
  };
}

describe("createSourceClassifier", () => {
  const base = {
    "charlesvestal/fm1-base@b1": [{ path: "bsp", type: "commit", sha: "p1" }],
    "charlesvestal/fm1-base@b2": [{ path: "bsp", type: "commit", sha: "p2" }],
    "hugelton/felucca-bsp@p1": [{ path: "chip/ota.c", type: "blob" }],
    "hugelton/felucca-bsp@p2": [{ path: "chip/ota.c", type: "blob" }],
  };
  const baseFiles = {
    "charlesvestal/fm1-base@b1:.gitmodules": `[submodule "bsp"]\npath = bsp\nurl = https://github.com/hugelton/felucca-bsp\n`,
    "charlesvestal/fm1-base@b2:.gitmodules": `[submodule "bsp"]\npath = bsp\nurl = https://github.com/hugelton/felucca-bsp\n`,
    "hugelton/felucca-bsp@p1:chip/ota.c": oldCheck,
    "hugelton/felucca-bsp@p2:chip/ota.c": fixedCheck,
  };
  const consumer = (repo, commit, pin) => ({
    trees: { [`${repo}@${commit}`]: [{ path: "base", type: "commit", sha: pin }, { path: "firmware/src/main.c", type: "blob" }] },
    files: { [`${repo}@${commit}:.gitmodules`]: `[submodule "base"]\npath = base\nurl = https://github.com/charlesvestal/fm1-base.git\n` },
  });

  it("classifies a repository's own copy", async () => {
    const github = fakeGitHub({
      trees: { "a/fw@c1": [{ path: "firmware/src/ota.c", type: "blob" }] },
      files: { "a/fw@c1:firmware/src/ota.c": oldCheck },
    });
    const result = await createSourceClassifier(github).classify("a/fw", "c1");
    assert.equal(result.status, "affected");
    assert.equal(result.basis, "own-copy");
    assert.equal(result.blob, blobId(Buffer.from(oldCheck)));
    assert.equal(result.sizeCheck, false);
  });

  it("follows fm1-base to its felucca-bsp pin, once per commit", async () => {
    const old = consumer("a/old", "c1", "b1");
    const fixed = consumer("b/fixed", "c2", "b2");
    const also = consumer("c/also-old", "c3", "b1");
    const github = fakeGitHub({
      trees: { ...base, ...old.trees, ...fixed.trees, ...also.trees },
      files: { ...baseFiles, ...old.files, ...fixed.files, ...also.files },
    });
    const classifier = createSourceClassifier(github);
    const first = await classifier.classify("a/old", "c1");
    assert.deepEqual([first.status, first.basis], ["affected", "old-base"]);
    const second = await classifier.classify("b/fixed", "c2");
    assert.deepEqual([second.status, second.basis], ["ok", "fixed-base"]);
    const third = await classifier.classify("c/also-old", "c3");
    assert.deepEqual([third.status, third.basis], ["affected", "old-base"]);
    assert.equal(github.calls.filter((call) => call.includes("fm1-base/git/trees/b1")).length, 1);
  });

  it("says a Felucca submodule's old check comes from the submodule", async () => {
    const github = fakeGitHub({
      trees: {
        "a/fw@c1": [{ path: "felucca", type: "commit", sha: "f1" }],
        "hugelton/Felucca@f1": [{ path: "firmware/src/ota.c", type: "blob" }],
      },
      files: {
        "a/fw@c1:.gitmodules": `[submodule "felucca"]\npath = felucca\nurl = https://github.com/hugelton/Felucca.git\n`,
        "hugelton/Felucca@f1:firmware/src/ota.c": oldCheck,
      },
    });
    const result = await createSourceClassifier(github).classify("a/fw", "c1");
    assert.deepEqual([result.status, result.basis], ["affected", "submodule"]);
  });

  it("says unknown when there's no update code", async () => {
    const github = fakeGitHub({ trees: { "a/fw@c1": [{ path: "README.md", type: "blob" }] }, files: {} });
    const result = await createSourceClassifier(github).classify("a/fw", "c1");
    assert.deepEqual([result.status, result.basis, result.kind], ["unclear", "unknown", null]);
  });

  it("throws when GitHub has no tree, so the caller keeps what it had", async () => {
    const github = fakeGitHub({ trees: {}, files: {} });
    await assert.rejects(createSourceClassifier(github).classify("a/fw", "c1"));
  });
});
