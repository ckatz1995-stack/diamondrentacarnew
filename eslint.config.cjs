module.exports = [
  {
    ignores: ["node_modules/**", "dist/**", ".wix/**"],
  },
  {
    files: ["**/*.js", "**/*.jsw"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        $w: "readonly",
        window: "readonly",
        navigator: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "no-console": "off",
    },
  },
];
