import { register } from "node:module";
import "./deno-shim.mjs";
register("./hooks.mjs", import.meta.url);
