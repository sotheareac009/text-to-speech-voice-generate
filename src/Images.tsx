/**
 * Pictures: type what you want, get it drawn on this Mac.
 *
 * The model is FLUX.2 Klein, 8-bit, running through MLX on the GPU in this
 * machine — so a picture costs nothing, works with no internet, carries no
 * watermark, and the prompt is never sent anywhere. It takes around forty
 * seconds, which is why the steps are reported as they happen rather than
 * leaving a bar sitting still.
 *
 * Everything drawn is kept in the gallery below, with the seed it was drawn
 * from, so a picture that came out well can be drawn again or varied.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Block } from "./Block";
import {
  deletePicture,
  eventsUrl,
  getPictures,
  picturePath,
  pictureUrl,
  startPicture,
  startPoster,
  uploadImage,
  type Picture,
  type PictureDesk,
} from "./shortsApi";

/**
 * Openers that turn a plain description into a photograph rather than an
 * illustration. They are suggestions on buttons, not something applied behind
 * the person's back: what is sent is exactly what is in the box.
 */
const PRESETS = [
  { value: "1080x1350", label: "Portrait 4:5 — 1080×1350" },
  { value: "1080x1080", label: "Square — 1080×1080" },
  { value: "1080x1920", label: "Story 9:16 — 1080×1920" },
  { value: "1200x1500", label: "Print-ish 4:5 — 1200×1500" },
];

const LOOKS = [
  { label: "Photo", add: "documentary photograph, natural light, shallow depth of field" },
  { label: "Cinematic", add: "cinematic still, 35mm, dramatic lighting, film grain" },
  { label: "Product", add: "product photograph on a clean surface, soft studio light" },
  { label: "Illustration", add: "flat vector illustration, bold shapes, limited palette" },
  { label: "3D", add: "soft 3D render, clay materials, gentle rim light" },
];

export default function Images() {
  const [desk, setDesk] = useState<PictureDesk | null>(null);
  const [offline, setOffline] = useState("");
  const [error, setError] = useState("");

  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("vertical");
  const [steps, setSteps] = useState(4);
  const [seed, setSeed] = useState<string>("");
  /*
   * On by default.
   *
   * The model reads English captions, and a word that means something else in
   * English comes back as the wrong picture forty seconds later: "a man
   * holding cafe" put a pastry in his hand, because in English a cafe is the
   * shop. Claude says the same thing in words the model understands before
   * anything is drawn, and shows what it sent.
   */
  const [improve, setImprove] = useState(true);
  /*
   * Khmer mode.
   *
   * Image models have seen far more Thai and Vietnamese photographs than
   * Khmer ones, so "a market in Cambodia" drifts to Bangkok on its own: Thai
   * roofs, Vietnamese hats, and writing in a script that is not Khmer. This
   * names what belongs and what does not, which is what actually holds a
   * picture in Cambodia.
   */
  const [khmer, setKhmer] = useState(false);
  /*
   * Words put on the picture after the model is done.
   *
   * Not a request to the model: it cannot form Khmer letters, and asked for a
   * Khmer sign it draws Lao-looking marks. These are set in Kantumruy Pro
   * through libass, the same way the video captions are, so what comes out
   * says exactly what was typed.
   */
  const [text, setText] = useState("");
  const [textPlace, setTextPlace] = useState("bottom");

  /*
   * Picture or poster.
   *
   * They are different jobs, not one job with options. A picture is drawn by
   * the model. A poster is typeset: the model is given the background at
   * most, and every readable word is set in a real font afterwards, because
   * the model draws Khmer as Lao-looking marks that say nothing.
   */
  const [mode, setMode] = useState<"picture" | "poster">("picture");
  const [heading, setHeading] = useState("");
  const [sub, setSub] = useState("");
  const [colour, setColour] = useState("#3E9E7A");
  const [posterW, setPosterW] = useState(1080);
  const [posterH, setPosterH] = useState(1350);
  const [background, setBackground] = useState("");
  const [layout, setLayout] = useState<"promo" | "plain">("promo");
  const [hero, setHero] = useState<{ name: string; path: string } | null>(null);
  const [call, setCall] = useState("");
  const [phone, setPhone] = useState("");
  const [telegram, setTelegram] = useState("");
  const [website, setWebsite] = useState("");
  const heroRef = useRef<HTMLInputElement>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [picture, setPicture] = useState<Picture | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      setDesk(await getPictures());
      setOffline("");
    } catch {
      setDesk(null);
      setOffline("not running");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (offline) {
    return (
      <Block
        title="The shorts engine isn't running"
        note="Pictures are drawn by the same engine as Shorts and Dub. Voice Studio does not start it — you do, once, in a terminal."
      >
        <pre className="setup-log" style={{ marginTop: 0 }}>
          cd ~/Desktop/Reach/shorts-studio{"\n"}npm run dev
        </pre>
        <div className="setup-row">
          <button className="btn primary" onClick={load}>
            Look again
          </button>
        </div>
      </Block>
    );
  }

  const sizes = desk?.sizes ?? [];
  const gallery = desk?.items ?? [];
  const ready = desk?.ready ?? false;

  function draw(again?: Picture) {
    const words = (again?.prompt ?? prompt).trim();
    if (!words) return;
    setError("");
    setStatus("");
    setProgress(0);
    setPicture(null);
    setRunning(true);
    startPicture({
      prompt: words,
      size: again?.size ?? size,
      steps: again?.steps ?? steps,
      improve,
      khmer,
      text: again ? (again.text ?? "") : text,
      textPlace,
      // A blank seed means a different picture every time, which is what
      // "draw it again" should do. Drawing from the gallery reuses nothing
      // but the words, so a variation is a variation.
      seed: seed.trim() === "" ? undefined : Number(seed),
    })
      .then(({ jobId }) => listen(jobId))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setRunning(false);
      });
  }

  /** Follow a job to its end, whichever kind it is. */
  function listen(jobId: string) {
    {
        const stream = new EventSource(eventsUrl(jobId));
        stream.addEventListener("log", (e) => {
          const data = JSON.parse((e as MessageEvent).data) as { line: string; progress: number };
          setStatus(data.line.replace(/^\[[^\]]+\]\s*/, ""));
          setProgress(data.progress);
        });
        stream.addEventListener("done", (e) => {
          const made = JSON.parse((e as MessageEvent).data) as Picture;
          setPicture(made);
          setProgress(1);
          setRunning(false);
          stream.close();
          load();
        });
        stream.addEventListener("error", (e) => {
          const raw = (e as MessageEvent).data;
          if (raw) {
            setError((JSON.parse(raw) as { error: string }).error);
            setRunning(false);
            stream.close();
          }
        });
    }
  }

  function makePoster() {
    if (!heading.trim()) return;
    setError("");
    setStatus("");
    setProgress(0);
    setPicture(null);
    setRunning(true);
    startPoster({
      heading: heading.trim(),
      sub: sub.trim() || undefined,
      colour,
      width: posterW,
      height: posterH,
      background: background.trim() || undefined,
      place: textPlace === "top" ? "top" : "bottom",
      steps,
      layout,
      hero: hero?.path,
      call: call.trim() || undefined,
      phone: phone.trim() || undefined,
      telegram: telegram.trim() || undefined,
      website: website.trim() || undefined,
    })
      .then(({ jobId }) => listen(jobId))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setRunning(false);
      });
  }

  const shown = picture;

  return (
    <>
      {error && <div className="alert">{error}</div>}

      {!ready && (
        <Block
          title="The picture model isn't installed"
          note="Pictures are drawn by FLUX.2 Klein running on this Mac. It is a one-time download of about 9 GB."
        >
          <pre className="setup-log" style={{ marginTop: 0 }}>
            cd ~/Desktop/Reach/shorts-studio{"\n"}
            python3 -m venv .venv-image{"\n"}
            .venv-image/bin/pip install mflux
          </pre>
          <div className="setup-row">
            <button className="btn primary" onClick={load}>
              Look again
            </button>
          </div>
        </Block>
      )}

      <div className="mode-row">
        <button
          className={mode === "picture" ? "mode on" : "mode"}
          onClick={() => setMode("picture")}
          disabled={running}
        >
          Picture
        </button>
        <button
          className={mode === "poster" ? "mode on" : "mode"}
          onClick={() => setMode("poster")}
          disabled={running}
        >
          Poster
        </button>
      </div>

      {mode === "poster" && (
        <>
          <Block
            title="The words"
            note="Set in Kantumruy Pro after the picture is made, never drawn by the model — so Khmer is Khmer, spelled exactly as you type it."
          >
            <label className="field" style={{ marginTop: 0 }}>
              <span>Heading</span>
              <textarea
                className="prompt-box"
                rows={2}
                value={heading}
                placeholder="ងាយមើល ងាយកុម្ម៉ង់ គ្រប់គ្រងកាន់តែស្រួល"
                onChange={(e) => setHeading(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Subtext</span>
              <textarea
                className="prompt-box"
                rows={3}
                value={sub}
                placeholder="ជាមួយ Digital Menu អ្នកអាចសង្ខេបរបាយការណ៍លក់…"
                onChange={(e) => setSub(e.target.value)}
              />
            </label>
            <p className="hint muted">
              The size of the type is measured, not guessed: it is rendered, its ink measured, and
              brought down until it fits — so a long heading never runs off the edge.
            </p>
          </Block>

          <Block
            title="The product"
            note="The screenshot or photograph that sits in the middle — a tablet, a phone, whatever is being sold. It is placed as it is, never redrawn."
          >
            <input
              ref={heroRef}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const chosen = e.target.files?.[0];
                if (!chosen) return;
                try {
                  setHero({ name: chosen.name, path: await uploadImage(chosen) });
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            />
            <div className="sample-row">
              <button
                className="btn ghost"
                onClick={() => heroRef.current?.click()}
                disabled={running}
              >
                Choose an image…
              </button>
              <span className={hero ? "sample-name ok" : "sample-name"}>
                {hero ? `✓ ${hero.name}` : "None — the middle stays open"}
              </span>
              {hero && (
                <button className="btn ghost tiny" onClick={() => setHero(null)}>
                  Remove
                </button>
              )}
            </div>
          </Block>

          <Block title="Contact" note="Left out of the poster when left empty.">
            <label className="field" style={{ marginTop: 0 }}>
              <span>Line above the contacts</span>
              <input
                className="seed-input"
                type="text"
                style={{ width: "100%" }}
                value={call}
                placeholder="ទាក់ទងមកពួកយើងឥឡូវនេះ"
                onChange={(e) => setCall(e.target.value)}
              />
            </label>
            <div className="shorts-row">
              <label className="field grow" style={{ marginTop: 0 }}>
                <span>Phone</span>
                <input
                  className="seed-input"
                  type="text"
                  style={{ width: "100%" }}
                  value={phone}
                  placeholder="070 277688 / 012 755 975"
                  onChange={(e) => setPhone(e.target.value)}
                />
              </label>
              <label className="field grow" style={{ marginTop: 0 }}>
                <span>Telegram</span>
                <input
                  className="seed-input"
                  type="text"
                  style={{ width: "100%" }}
                  value={telegram}
                  placeholder="070 277688"
                  onChange={(e) => setTelegram(e.target.value)}
                />
              </label>
              <label className="field grow" style={{ marginTop: 0 }}>
                <span>Website</span>
                <input
                  className="seed-input"
                  type="text"
                  style={{ width: "100%" }}
                  value={website}
                  placeholder="my-store.shop"
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </label>
            </div>
          </Block>

          <Block title="Size and colour">
            <div className="shorts-row" style={{ marginTop: 0 }}>
              <label className="field" style={{ marginTop: 0 }}>
                <span>Preset</span>
                <span className="select-wrap">
                  <select
                    value={`${posterW}x${posterH}`}
                    onChange={(e) => {
                      const [w, h] = e.target.value.split("x").map(Number);
                      setPosterW(w);
                      setPosterH(h);
                    }}
                  >
                    {PRESETS.map((x) => (
                      <option key={x.value} value={x.value}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              <label className="field" style={{ marginTop: 0 }}>
                <span>Width</span>
                <input
                  className="seed-input"
                  type="text"
                  value={posterW}
                  inputMode="numeric"
                  onChange={(e) => setPosterW(Number(e.target.value.replace(/[^0-9]/g, "")) || 0)}
                />
              </label>
              <label className="field" style={{ marginTop: 0 }}>
                <span>Height</span>
                <input
                  className="seed-input"
                  type="text"
                  value={posterH}
                  inputMode="numeric"
                  onChange={(e) => setPosterH(Number(e.target.value.replace(/[^0-9]/g, "")) || 0)}
                />
              </label>
              <label className="field" style={{ marginTop: 0 }}>
                <span>Style</span>
                <span className="select-wrap">
                  <select
                    value={layout}
                    onChange={(e) => setLayout(e.target.value as "promo" | "plain")}
                  >
                    <option value="promo">Promo — lozenge, pill, contacts, wave</option>
                    <option value="plain">Plain — type on a field</option>
                  </select>
                </span>
              </label>
              <label className="swatch" style={{ alignSelf: "end", paddingBottom: 9 }}>
                <input
                  type="color"
                  value={colour}
                  onChange={(e) => setColour(e.target.value.toUpperCase())}
                />
                <span>{colour}</span>
              </label>
            </div>
            <p className="hint muted">
              Any size, exactly — 1080×1350 is not a multiple of 16, which the model needs, so the
              model draws at a size it can and the poster is composed at yours.
            </p>
          </Block>

          <Block
            title="Background"
            note="Leave it empty for a clean coloured poster, made instantly. Describe something and the model draws it — with no writing in it."
          >
            <textarea
              className="prompt-box"
              rows={2}
              value={background}
              placeholder="a waiter holding a tablet at a restaurant table…"
              onChange={(e) => setBackground(e.target.value)}
            />
            {background.trim() && (
              <div className="shorts-row">
                <label className="field" style={{ marginTop: 0 }}>
                  <span>Words sit</span>
                  <span className="select-wrap">
                    <select value={textPlace} onChange={(e) => setTextPlace(e.target.value)}>
                      <option value="bottom">On a panel at the bottom</option>
                      <option value="top">On a panel at the top</option>
                    </select>
                  </span>
                </label>
              </div>
            )}
          </Block>

          <Block title="Make it">
            <div className="setup-row" style={{ marginTop: 0 }}>
              <button
                className="btn primary"
                onClick={makePoster}
                disabled={!heading.trim() || running || (!!background.trim() && !ready)}
              >
                {running ? "Making…" : "Generate poster"}
              </button>
              {(running || progress > 0) && (
                <div className="progress">
                  <i style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              {status && (
                <span className="hint muted" style={{ margin: 0 }}>
                  {status}
                </span>
              )}
            </div>
            {shown && <Result picture={shown} onSave={() => savePicture(shown.file, setError)} />}
          </Block>
        </>
      )}

      {mode === "picture" && (
      <>
      <Block
        title="Describe the picture"
        note="Plain description works best — what is in it, where, and what the light is doing. Nothing is sent anywhere; the model is on this machine."
      >
        <textarea
          ref={boxRef}
          className="prompt-box"
          rows={4}
          value={prompt}
          placeholder="A Cambodian iced coffee on a street cafe table, warm morning light…"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter draws, the way a send box works.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !running) draw();
          }}
        />
        <label className="switch" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={improve}
            onChange={(e) => setImprove(e.target.checked)}
          />
          <span>Let Claude put it into the English the model reads</span>
        </label>
        <label className="switch" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={khmer} onChange={(e) => setKhmer(e.target.checked)} />
          <span>Khmer mode — Cambodia, not Thailand or Vietnam</span>
        </label>
        {khmer && (
          <p className="hint muted">
            Khmer people and Khmer surroundings: colonial shophouses, naga roofs, remork tuk-tuks,
            krama scarves — and Thai, Lao and Vietnamese cues ruled out by name, which is what
            actually keeps it in Cambodia. Signs are asked for in Khmer script, but the model
            cannot spell in any language, so treat lettering as decoration, not words.
          </p>
        )}
        <p className="hint muted">
          The model is given English and reads it literally — in English a “cafe” is the shop,
          not the drink. This fixes that, translates Khmer, and adds nothing you did not ask for.
          You always see what was sent.
        </p>
        <div className="chip-row">
          {LOOKS.map((look) => (
            <button
              key={look.label}
              className="chip"
              disabled={running}
              onClick={() =>
                setPrompt((p) => (p.trim() ? `${p.replace(/[,\s]+$/, "")}, ${look.add}` : look.add))
              }
            >
              + {look.label}
            </button>
          ))}
        </div>
      </Block>

      <Block
        title="Words on the picture"
        note="Optional, and not drawn by the model — set afterwards in Kantumruy Pro, so Khmer comes out as Khmer, spelled exactly as you type it."
      >
        <textarea
          className="prompt-box"
          rows={2}
          value={text}
          placeholder="ហាងកាហ្វេខ្មែរ"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="shorts-row">
          <label className="field" style={{ marginTop: 0 }}>
            <span>Where</span>
            <span className="select-wrap">
              <select value={textPlace} onChange={(e) => setTextPlace(e.target.value)}>
                <option value="bottom">Bottom</option>
                <option value="middle">Middle</option>
                <option value="top">Top</option>
              </select>
            </span>
          </label>
          <p className="hint muted" style={{ margin: 0, alignSelf: "end" }}>
            Up to three lines. Leave it empty for a picture with no words.
          </p>
        </div>
      </Block>

      <Block title="Shape and detail">
        <div className="shorts-row" style={{ marginTop: 0 }}>
          <label className="field grow" style={{ marginTop: 0 }}>
            <span>Shape</span>
            <span className="select-wrap">
              <select value={size} onChange={(e) => setSize(e.target.value)}>
                {sizes.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label} — {s.width}×{s.height}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Steps</span>
            <span className="select-wrap">
              <select value={steps} onChange={(e) => setSteps(Number(e.target.value))}>
                <option value={2}>2 — fastest</option>
                <option value={4}>4 — recommended</option>
                <option value={6}>6 — more detail</option>
                <option value={8}>8 — slowest</option>
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Seed</span>
            <input
              className="seed-input"
            type="text"
              value={seed}
              placeholder="random"
              inputMode="numeric"
              onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </label>
        </div>
        <p className="hint muted">
          Each step is about eight seconds, so four of them is a picture in roughly forty. The
          seed is what makes two tries differ — fix it to change the wording and keep the picture.
        </p>
      </Block>

      <Block title="Draw it">
        <div className="setup-row" style={{ marginTop: 0 }}>
          <button
            className="btn primary"
            onClick={() => draw()}
            disabled={!prompt.trim() || running || !ready}
          >
            {running ? "Drawing…" : "Generate picture"}
          </button>
          {(running || progress > 0) && (
            <div className="progress">
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          {status && (
            <span className="hint muted" style={{ margin: 0 }}>
              {status}
            </span>
          )}
        </div>

        {shown && (
          <div className="picture-result">
            <img src={pictureUrl(shown.file)} alt={shown.prompt} />
            <div className="short-side">
              <strong>{shown.width}×{shown.height}</strong>
              <span className="hint muted" style={{ margin: 0 }}>
                {shown.seconds.toFixed(1)}s · {(shown.bytes / 1e6).toFixed(1)} MB · seed{" "}
                {shown.seed} · {shown.steps} steps
              </span>
              {shown.drawn && (
                <span className="drawn-as" title={shown.drawn}>
                  <strong>Drawn as</strong> {shown.drawn}
                </span>
              )}
              <button className="btn ghost tiny" onClick={() => savePicture(shown.file, setError)}>
                {isTauri() ? "Show in Finder" : "Download"}
              </button>
              <button className="btn ghost tiny" disabled={running} onClick={() => draw()}>
                Draw another
              </button>
              <button
                className="btn ghost tiny"
                onClick={() => {
                  setSeed(String(shown.seed));
                  setPrompt(shown.prompt);
                  boxRef.current?.focus();
                }}
              >
                Keep this one and edit
              </button>
            </div>
          </div>
        )}
      </Block>

      </>
      )}

      {gallery.length > 0 && (
        <Block title="Everything drawn here" note="Newest first. Click one to bring it back.">
          <div className="picture-grid">
            {gallery.map((item) => (
              <figure
                key={item.id}
                className={picture?.id === item.id ? "picture-tile active" : "picture-tile"}
              >
                <button onClick={() => setPicture(item)}>
                  <img src={pictureUrl(item.file)} alt={item.prompt} loading="lazy" />
                </button>
                <figcaption title={item.prompt}>{item.prompt}</figcaption>
                <button
                  className="take-drop"
                  title="Delete"
                  onClick={async () => {
                    await deletePicture(item.id).catch(() => undefined);
                    if (picture?.id === item.id) setPicture(null);
                    load();
                  }}
                >
                  ✕
                </button>
              </figure>
            ))}
          </div>
        </Block>
      )}
    </>
  );
}


/** The thing just made, with what it is and what to do with it. */
function Result({ picture, onSave }: { picture: Picture; onSave: () => void }) {
  return (
    <div className="picture-result">
      <img src={pictureUrl(picture.file)} alt={picture.prompt} />
      <div className="short-side">
        <strong>
          {picture.width}×{picture.height}
        </strong>
        <span className="hint muted" style={{ margin: 0 }}>
          {picture.seconds.toFixed(1)}s · {(picture.bytes / 1e6).toFixed(1)} MB
        </span>
        <button className="btn ghost tiny" onClick={onSave}>
          {isTauri() ? "Show in Finder" : "Download"}
        </button>
      </div>
    </div>
  );
}

/**
 * Hand a picture to the person.
 *
 * Never as a link in the app: WKWebView ignores the `download` attribute, so
 * an anchor navigates this window to the file instead. In a browser, where
 * anchors behave, the anchor is used.
 */
async function savePicture(file: string, setError: (m: string) => void) {
  try {
    if (isTauri()) {
      await revealItemInDir(await picturePath(file));
    } else {
      const link = document.createElement("a");
      link.href = pictureUrl(file);
      link.download = file;
      link.click();
    }
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}
