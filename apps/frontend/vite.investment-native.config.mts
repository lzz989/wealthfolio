import path from "node:path";
import upstream from "./vite.config";

export default {
  ...upstream,
  build: {
    ...upstream.build,
    outDir: path.resolve(__dirname, "../../tmp/analysis-native-dist"),
    emptyOutDir: true,
  },
};
