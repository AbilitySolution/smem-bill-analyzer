import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Edge Functions Supabase : code Deno (imports `npm:`/`jsr:`, globale `Deno`),
    // hors du périmètre du bundle Next et de ses règles.
    "supabase/functions/**",
  ]),
]);

export default eslintConfig;
