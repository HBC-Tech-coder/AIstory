import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ["app/**/*.{js,jsx,ts,tsx}", "components/**/*.{js,jsx,ts,tsx}"],
    rules: {
      // Existing client flows intentionally hydrate local/browser state in effects.
      // Keep these React Compiler diagnostics visible through lint:full after the
      // legacy flows are migrated instead of blocking the P1 provider baseline.
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  globalIgnores([
    ".next/**",
    ".open-next/**",
    ".wrangler/**",
    ".aistory-*/**",
    ".test-*/**",
    "build/**",
    "dist/**",
    "out/**",
    "next-env.d.ts",
    "public/**",
  ]),
]);
