// Preload for lazy-loading regressions: prints `LOADED <package>` to stderr when a heavy optional dependency is first evaluated.

import { readFileSync } from "node:fs";
import { plugin } from "bun";

const seen = new Set<string>();
plugin({
	name: "trace-heavy-modules",
	setup(build) {
		build.onLoad(
			{ filter: /node_modules\/(fastembed|sqlite-vec|notjev|lunar-typescript|onnxruntime-node)\/.*\.(m|c)?js$/ },
			(args) => {
				const name = /node_modules\/([^/]+)/.exec(args.path)?.[1] ?? args.path;
				if (!seen.has(name)) {
					seen.add(name);
					console.error(`LOADED ${name}`);
				}
				return { contents: readFileSync(args.path, "utf8"), loader: "js" };
			},
		);
	},
});
