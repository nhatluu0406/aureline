import { rm } from "node:fs/promises";
import { resolve } from "node:path";
const root=resolve(import.meta.dirname,"../..");
for(const name of ["dist","release","test-results"])await rm(resolve(root,name),{recursive:true,force:true});
