import { sqlite } from "@flue/runtime/node";

import { managedPaths } from "./managed/paths.js";

export default sqlite(managedPaths().flueDatabase);
