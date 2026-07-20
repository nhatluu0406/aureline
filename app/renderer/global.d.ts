import type { ForgeDesktopApi } from "../packages/contracts/index.ts";
declare global { interface Window { forgeDesktop: ForgeDesktopApi } }
export {};
