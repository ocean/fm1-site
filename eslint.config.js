import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "dist/", ".artifacts/"],
  },
  js.configs.recommended,
  {
    // The site's own scripts run in the browser.
    files: ["assets/**/*.js", "bootloader-check/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: globals.browser,
    },
  },
  {
    // Build and check scripts run in Node.
    files: ["scripts/**/*.mjs", "*.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The check script also passes functions to the browser to run in the page.
    files: ["scripts/check-site.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
