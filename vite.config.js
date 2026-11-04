import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { deployArtifact, gitShortSha } from "pattern-app-kit/vite";

// Single-app standalone. `deployArtifact({ dataFree: true })` fails the build if any
// dataset (*.csv or a data/ dir) ends up in the output, turning publicDir:false from
// "prevented" into "verified". Entry is plain index.html, so no HTML rename is needed
// (deployArtifact's `entry:` option is only for differently-named entry HTML).
export default defineConfig({
  plugins: [react(), deployArtifact({ dataFree: true })],
  define: { __APP_VERSION__: JSON.stringify(gitShortSha()) },
  base: "",
  publicDir: false,
  resolve: { dedupe: ["react", "react-dom"] }, // guards against duplicate React when file:-linking the kit
  optimizeDeps: { exclude: ["d3-scale"] },      // viz_sandbox dep-optimizer interop quirk
});
