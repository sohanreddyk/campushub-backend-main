import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  // client/ has its own ESLint config, dist/ and coverage/ are build output,
  // and .github/ holds CI tooling rather than application code.
  globalIgnores(["dist", "coverage", "client", ".github"]),
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      // CLAUDE.md §3: `any` and @ts-ignore are disallowed.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
    },
  },
]);
