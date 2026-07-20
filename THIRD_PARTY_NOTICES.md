# Third-party notices

Aureline-owned source code in this repository is licensed under the MIT License in [`LICENSE`](LICENSE).

Stable Diffusion WebUI Forge is a third-party runtime/engine licensed under the GNU Affero General Public License v3.0. Forge source is not included as Aureline-owned source at this repository root and is not relicensed under MIT. Any Aureline distribution that materializes or bundles Forge must preserve the applicable license and notices, provide the required Corresponding Source offer or access, and satisfy the licenses of Forge's own bundled components.

The optional ignored checkout at `.reference/stable-diffusion-webui-forge` comes from the [official upstream repository](https://github.com/lllyasviel/stable-diffusion-webui-forge). Its presence does not change the license boundary: it remains AGPL-3.0 third-party source and is never part of Aureline's MIT-licensed source or shell package.

Electron, Chromium, Node.js, React, Rust, Python, FastAPI, Gradio, and npm/Python/Rust dependencies retain their respective licenses. Release automation must generate and review a dependency inventory and ship the notices and source information required by the exact versions included in an artifact.

Models are not bundled. Model licenses and provenance remain separate from the Aureline application and engine-runtime licenses.

Civitai is an external third-party model metadata and file provider. Aureline does not bundle Civitai content, does not claim ownership of downloaded models or previews, and does not change the license attached by a model creator/provider. Users must review each model's license and usage terms before downloading or using it.

This notice records the intended technical license boundary and does not replace a legal review of a release artifact.
