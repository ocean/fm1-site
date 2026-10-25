// FM-SWITCH's firmware badges, as the app draws them: two characters on two colours, all from
// the firmware's name. A port of FM-SWITCH's App/Model/FirmwareBadgeDesign.swift; keep the two
// in step, so a firmware's badge here is the one people see in the app.

const commonWords = new Set(["firmware", "official", "the", "for", "of", "and", "fm", "fm1", "fm-1"]);
const hueCount = 16;

const isLetterOrNumber = (character) => /[\p{L}\p{N}]/u.test(character);

const initial = (word) => [...word].find(isLetterOrNumber) ?? "";

// A word split at hyphens and where a lower-case letter meets a capital.
function parts(word) {
  const found = [];
  let current = "";
  let previous;
  for (const character of word) {
    if (character === "-") {
      found.push(current);
      current = "";
    } else {
      if (previous && /\p{Ll}/u.test(previous) && /\p{Lu}/u.test(character)) {
        found.push(current);
        current = "";
      }
      current += character;
    }
    previous = character;
  }
  found.push(current);
  return found.filter((part) => [...part].some(isLetterOrNumber));
}

// Two characters from the name: the first and last words' initials, or for one word, the initials
// of its parts, or its first two characters as written.
export function badgeLetters(name) {
  const allWords = name
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((word) => [...word].some(isLetterOrNumber));
  const distinctive = allWords.filter((word) => !commonWords.has(word.toLowerCase()));
  const words = distinctive.length > 0 ? distinctive : allWords;
  if (words.length === 0) return "?";
  if (words.length > 1) return (initial(words[0]) + initial(words.at(-1))).toUpperCase();
  const allParts = parts(words[0]);
  const distinctiveParts = allParts.filter((part) => !commonWords.has(part.toLowerCase()));
  const chosen = distinctiveParts.length > 0 ? distinctiveParts : allParts;
  if (chosen.length > 1) return (initial(chosen[0]) + initial(chosen.at(-1))).toUpperCase();
  const characters = [...(chosen[0] ?? words[0])].filter(isLetterOrNumber);
  return (characters[0] ?? "").toUpperCase() + (characters[1] ?? "");
}

// The name, ignoring case and punctuation, hashed with FNV-1a.
function seed(name) {
  const normalised = [...name.toLowerCase()].filter(isLetterOrNumber).join("");
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(normalised)) {
    hash = Math.imul(hash ^ byte, 16_777_619) >>> 0;
  }
  return hash;
}

const hue = (step) => 25 + (step * 360) / hueCount;

// OKLCH to 0xRRGGBB, clipped to sRGB.
function oklch(lightness, chroma, degrees) {
  const angle = (degrees * Math.PI) / 180;
  const [greenRed, blueYellow] = [chroma * Math.cos(angle), chroma * Math.sin(angle)];
  const long = (lightness + 0.3963377774 * greenRed + 0.2158037573 * blueYellow) ** 3;
  const medium = (lightness - 0.1055613458 * greenRed - 0.0638541728 * blueYellow) ** 3;
  const short = (lightness - 0.0894841775 * greenRed - 1.291485548 * blueYellow) ** 3;
  const linear = [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707695658 * short,
  ];
  return linear.reduce((value, channel) => {
    const clipped = Math.min(Math.max(channel, 0), 1);
    const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
    return ((value << 8) | Math.round(encoded * 255)) >>> 0;
  }, 0);
}

function luminance(rgb) {
  const [red, green, blue] = [16, 8, 0].map((shift) => {
    const value = ((rgb >> shift) & 0xff) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const [one, two] = [luminance(first), luminance(second)];
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

// The two halves and the letters, with the letters readable on each.
function colours(lightHue, darkHue, isPale) {
  const [light, dark] = [hue(lightHue), hue(darkHue)];
  if (isPale) {
    const lightHalf = oklch(0.95, 0.05, light);
    const darkHalf = oklch(0.8, 0.13, dark);
    let lightness = 0.27;
    const ink = () => oklch(lightness, 0.07, light);
    while (Math.min(contrast(ink(), lightHalf), contrast(ink(), darkHalf)) < 4.5) {
      lightness -= 0.01;
    }
    return { light: lightHalf, dark: darkHalf, ink: ink() };
  }
  const white = 0xffffff;
  let lightness = 0.6;
  while (contrast(white, oklch(lightness, 0.15, light)) < 4.5) {
    lightness -= 0.01;
  }
  return { light: oklch(lightness, 0.15, light), dark: oklch(0.33, 0.12, dark), ink: white };
}

const hex = (rgb) => `#${rgb.toString(16).padStart(6, "0")}`;

// A firmware's badge: its letters, its two halves (top or top-left first), how they're split
// ("across" or "diagonal"), and the letters' colour, as CSS hex colours.
export function firmwareBadge(name, { isOfficial = false, version } = {}) {
  if (isOfficial) {
    const letters = version && version.length <= 4 ? version : badgeLetters(name);
    return { letters, first: "#1c1c1e", second: "#1c1c1e", split: "across", ink: "#ffffff" };
  }
  const value = seed(name);
  const lightHue = value % hueCount;
  const darkHue = (lightHue + 5 + ((value >>> 8) % 7)) % hueCount;
  const isPale = ((value >>> 16) & 1) === 0;
  const halves = colours(lightHue, darkHue, isPale);
  const isLightFirst = ((value >>> 20) & 1) === 0;
  return {
    letters: badgeLetters(name),
    first: hex(isLightFirst ? halves.light : halves.dark),
    second: hex(isLightFirst ? halves.dark : halves.light),
    split: ((value >>> 24) & 1) === 0 ? "across" : "diagonal",
    ink: hex(halves.ink),
  };
}
