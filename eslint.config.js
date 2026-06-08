import eslint from "@eslint/js";
import globals from "globals";

export default [
  eslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // forge has legacy try/catch patterns where the caught error is
      // intentionally swallowed (e.g. cleanup, optional probes); enforcing
      // cause-attachment / non-empty bodies repo-wide would balloon scope.
      "preserve-caught-error": "off",
      "no-empty": "off",
      "curly": ["error", "all"],
      "brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "indent": ["error", 2, { SwitchCase: 1 }],
    },
  },
  {
    ignores: ["node_modules/", "lib/vendor/", "dist/"],
  },
];

