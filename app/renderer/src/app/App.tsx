import { useEffect, useRef, useState } from "react";
import { Aperture, Check, CircleAlert, Image as ImageIcon, LoaderCircle, Maximize2, Minimize2, Moon, PlugZap, Settings, SlidersHorizontal, Sparkles, Sun, WandSparkles, X } from "lucide-react";
import type { DesktopSettings } from "../../../../packages/contracts/index.ts";

type Page = "studio" | "settings";
type Connection = "unknown" | "testing" | "connected" | "disconnected";
type Generation = "idle" | "running" | "success" | "error";

export function App() {
  const [page, setPage] = useState<Page>("studio");
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [connection, setConnection] = useState<Connection>("unknown");
  const [connectionMessage, setConnectionMessage] = useState("Connection not tested");
  const [generation, setGeneration] = useState<Generation>("idle");
  const [generationMessage, setGenerationMessage] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [resultSeed, setResultSeed] = useState<number | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    void window.aureline.settings.get().then(value => { setSettings(value); hydrated.current = true; });
  }, []);

  useEffect(() => {
    if (!settings) return;
    document.documentElement.dataset.theme = settings.theme;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => { document.documentElement.dataset.systemDark = String(query.matches); };
    sync(); query.addEventListener("change", sync); return () => query.removeEventListener("change", sync);
  }, [settings?.theme]);

  useEffect(() => {
    if (!settings || !hydrated.current) return;
    const timer = window.setTimeout(() => { void window.aureline.settings.update({ studio: settings.studio }); }, 450);
    return () => window.clearTimeout(timer);
  }, [settings?.studio]);

  useEffect(() => {
    if (!settings || !hydrated.current) return;
    const timer = window.setTimeout(() => { void window.aureline.settings.update({ forgeBaseUrl: settings.forgeBaseUrl }); }, 450);
    return () => window.clearTimeout(timer);
  }, [settings?.forgeBaseUrl]);

  if (!settings) return <div className="boot"><div className="aureline-glyph"><Sparkles /></div><span>Opening Aureline</span></div>;

  const updateStudio = <K extends keyof DesktopSettings["studio"]>(key: K, value: DesktopSettings["studio"][K]) => {
    setSettings(current => current ? { ...current, studio: { ...current.studio, [key]: value } } : current);
  };
  const persist = async (patch: Partial<Omit<DesktopSettings, "schemaVersion">>) => {
    const next = await window.aureline.settings.update(patch); setSettings(next); return next;
  };
  const testConnection = async () => {
    setConnection("testing"); setConnectionMessage("Checking Forge API…");
    const result = await window.aureline.forge.testConnection(settings.forgeBaseUrl);
    setConnection(result.ok ? "connected" : "disconnected"); setConnectionMessage(result.message);
  };
  const generate = async () => {
    const prompt = settings.studio.prompt.trim();
    if (!prompt) { setGeneration("error"); setGenerationMessage("Add a prompt before generating."); return; }
    setGeneration("running"); setGenerationMessage("Forge is creating your image…");
    await window.aureline.settings.update({ studio: settings.studio });
    const result = await window.aureline.forge.generate({ baseUrl: settings.forgeBaseUrl, ...settings.studio, prompt });
    if (result.ok) { setImage(result.image); setResultSeed(result.seed); setGeneration("success"); setGenerationMessage("Generation complete"); setConnection("connected"); }
    else { setGeneration("error"); setGenerationMessage(result.message); if (connection === "unknown") setConnection("disconnected"); }
  };

  return <div className="app-shell">
    <header className="titlebar">
      <div className="title-brand"><div className="mini-glyph"><Sparkles /></div><strong>Aureline</strong><span>/</span><span>{page === "studio" ? "Studio" : "Settings"}</span></div>
      <div className="title-drag" />
      <div className="window-actions">
        <button aria-label="Minimize" onClick={() => void window.aureline.app.window("minimize")}><Minimize2 /></button>
        <button aria-label="Maximize" onClick={() => void window.aureline.app.window("toggle-maximize")}><Maximize2 /></button>
        <button className="close" aria-label="Close" onClick={() => void window.aureline.app.window("close")}><X /></button>
      </div>
    </header>

    <aside className="rail" aria-label="Main navigation">
      <div className="aureline-glyph" title="Aureline"><Sparkles /></div>
      <nav>
        <button className={page === "studio" ? "active" : ""} onClick={() => setPage("studio")} aria-label="Studio"><WandSparkles /><span>Studio</span></button>
        <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")} aria-label="Settings"><Settings /><span>Settings</span></button>
      </nav>
      <div className={`connection-beacon ${connection}`} title={connectionMessage} />
    </aside>

    {page === "studio" ? <Studio
      value={settings.studio}
      connection={connection}
      generation={generation}
      message={generationMessage}
      image={image}
      resultSeed={resultSeed}
      onChange={updateStudio}
      onGenerate={() => void generate()}
      onOpenSettings={() => setPage("settings")}
    /> : <SettingsView
      value={settings}
      connection={connection}
      connectionMessage={connectionMessage}
      onChange={persist}
      onBaseUrlChange={forgeBaseUrl => { setSettings(current => current ? { ...current, forgeBaseUrl } : current); setConnection("unknown"); setConnectionMessage("Connection not tested"); }}
      onTest={() => void testConnection()}
      onDone={() => setPage("studio")}
    />}
  </div>;
}

type StudioProps = {
  value: DesktopSettings["studio"];
  connection: Connection;
  generation: Generation;
  message: string;
  image: string | null;
  resultSeed: number | null;
  onChange: <K extends keyof DesktopSettings["studio"]>(key: K, value: DesktopSettings["studio"][K]) => void;
  onGenerate: () => void;
  onOpenSettings: () => void;
};

function Studio({ value, connection, generation, message, image, resultSeed, onChange, onGenerate, onOpenSettings }: StudioProps) {
  const running = generation === "running";
  return <main className="studio-workspace">
    <section className="control-panel">
      <div className="workspace-heading"><div><span className="eyebrow">Create</span><h1>New image</h1></div><Aperture /></div>
      <div className="field-group">
        <label htmlFor="negative">Negative prompt</label>
        <textarea id="negative" rows={3} value={value.negativePrompt} placeholder="What should the image avoid?" onChange={event => onChange("negativePrompt", event.target.value)} />
      </div>
      <div className="section-label"><SlidersHorizontal /><span>Image settings</span></div>
      <div className="field-grid">
        <NumberField label="Width" value={value.width} min={256} max={2048} step={64} onChange={number => onChange("width", number)} />
        <NumberField label="Height" value={value.height} min={256} max={2048} step={64} onChange={number => onChange("height", number)} />
        <NumberField label="Steps" value={value.steps} min={1} max={150} onChange={number => onChange("steps", number)} />
        <NumberField label="CFG scale" value={value.cfgScale} min={1} max={30} step={0.5} onChange={number => onChange("cfgScale", number)} />
      </div>
      <div className="field-group"><label htmlFor="sampler">Sampler</label><select id="sampler" value={value.sampler} onChange={event => onChange("sampler", event.target.value)}><option>Euler a</option><option>Euler</option><option>DPM++ 2M</option><option>DPM++ 2M Karras</option><option>DPM++ SDE Karras</option></select></div>
      <div className="field-group"><label htmlFor="seed">Seed <span>−1 for random</span></label><input id="seed" type="number" min={-1} max={2147483647} value={value.seed} onChange={event => onChange("seed", Number(event.target.value))} /></div>
      <button className={`connection-card ${connection}`} onClick={onOpenSettings}>
        <span className="connection-icon"><PlugZap /></span><span><strong>{connection === "connected" ? "Forge connected" : "Connect Forge"}</strong><small>{connection === "connected" ? "Local API ready" : "Configure local API"}</small></span><span className="connection-dot" />
      </button>
    </section>

    <section className="creation-stage">
      <div className="stage-topbar"><div><span className="eyebrow">Canvas</span><strong>{image ? "Latest generation" : "Preview"}</strong></div>{resultSeed !== null && <span className="seed-chip">Seed {resultSeed}</span>}</div>
      <div className={`canvas ${generation}`}>
        {image ? <img src={image} alt="Generated result" /> : <div className="canvas-empty"><div className="empty-icon"><ImageIcon /></div><h2>Your next idea starts here</h2><p>Describe an image below, connect a local Forge API, and generate.</p></div>}
        {running && <div className="generating-overlay"><LoaderCircle /><strong>Creating your image</strong><span>This can take a moment on local hardware.</span></div>}
      </div>
      <div className="composer">
        <label htmlFor="prompt">Prompt</label>
        <textarea id="prompt" rows={3} autoFocus value={value.prompt} placeholder="Describe the image you want to create…" onChange={event => onChange("prompt", event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !running) onGenerate(); }} />
        <div className="composer-footer">
          <div className={`generation-status ${generation}`}>{generation === "success" ? <Check /> : generation === "error" ? <CircleAlert /> : <Sparkles />}<span>{message || "Ctrl + Enter to generate"}</span></div>
          <button className="generate-button" disabled={running || !value.prompt.trim()} onClick={onGenerate}>{running ? <LoaderCircle className="spin" /> : <Sparkles />}{running ? "Generating" : "Generate"}</button>
        </div>
      </div>
    </section>
  </main>;
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <div className="field-group"><label>{label}</label><input type="number" value={value} min={min} max={max} step={step} onChange={event => onChange(Number(event.target.value))} /></div>;
}

function SettingsView({ value, connection, connectionMessage, onChange, onBaseUrlChange, onTest, onDone }: { value: DesktopSettings; connection: Connection; connectionMessage: string; onChange: (patch: Partial<Omit<DesktopSettings, "schemaVersion">>) => Promise<DesktopSettings>; onBaseUrlChange: (value: string) => void; onTest: () => void; onDone: () => void }) {
  return <main className="settings-page">
    <header className="settings-header"><div><span className="eyebrow">Aureline</span><h1>Settings</h1><p>Connect your local creative engine and tune the application.</p></div><button className="secondary-button" onClick={onDone}>Done</button></header>
    <section className="settings-card forge-settings">
      <div className="settings-icon"><PlugZap /></div><div className="settings-copy"><h2>Local Forge API</h2><p>Aureline connects only to Forge running on this computer. Start Forge with API access enabled, then test the connection.</p>
        <label htmlFor="forge-url">Base URL</label><div className="url-row"><input id="forge-url" value={value.forgeBaseUrl} placeholder="http://127.0.0.1:7860" onChange={event => onBaseUrlChange(event.target.value)} /><button className="primary-button" disabled={connection === "testing"} onClick={onTest}>{connection === "testing" ? <LoaderCircle className="spin" /> : <PlugZap />}Test connection</button></div>
        <div className={`connection-result ${connection}`}>{connection === "connected" ? <Check /> : connection === "disconnected" ? <CircleAlert /> : <span className="connection-dot" />}<span>{connectionMessage}</span></div>
      </div>
    </section>
    <section className="settings-card compact"><div className="settings-icon"><Sun /></div><div className="settings-copy"><h2>Appearance</h2><p>Choose the surface that best fits your workspace.</p><div className="theme-picker">{(["dark", "light", "system"] as const).map(theme => <button key={theme} className={value.theme === theme ? "active" : ""} onClick={() => void onChange({ theme })}>{theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <Settings />}{theme}</button>)}</div></div></section>
    <p className="settings-note">Forge remains a separate local runtime. Aureline does not bundle models or upload prompts.</p>
  </main>;
}
