import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "dist/", ".artifacts/", ".wrangler/"],
  },
  js.configs.recommended,
  {
    // The site's own scripts run in the browser.
    files: ["assets/**/*.js"],
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
];
