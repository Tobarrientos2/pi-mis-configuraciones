/**
 * mis-configuraciones — Extensión de pi
 *
 * Comando /qa: arranca QA de KOBRA Learning v1 con selector interactivo.
 * Lee qa/state/qa-state.yml del proyecto y deja que el usuario elija:
 *   - Todos los pendientes
 *   - Re-correr todo (fuerza)
 *   - Un caso puntual (C01..C09)
 * Luego inyecta al agente el prompt del dispatcher (qa/dispatcher/CORRER-QA.md)
 * con el selector elegido ya aplicado en qa/state.yml.
 *
 * No duplica lógica: solo orquesta. Todo el know-how vive en qa/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const CASE_IDS = ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09"];

interface CaseState {
  id: string;
  area?: string;
  innegociable?: string;
  status: string;
}
interface QaState {
  selector?: { modo?: string; lista?: string[] };
  casos?: Record<string, CaseState>;
}

/** Busca la raíz del proyecto (la carpeta que contiene qa/) subiendo desde cwd. */
function findProjectRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "qa", "state", "qa-state.yml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Parser de YAML chico (solo lo que usa qa-state.yml: claves planas y anidadas con :). */
function parseSimpleYaml(text: string): QaState {
  const state: QaState = { selector: {}, casos: {} };
  const lines = text.split("\n");
  let section: "root" | "selector" | "casos" = "root";
  let currentCase: string | null = null;
  for (const raw of lines) {
    if (raw.trim().startsWith("#") || !raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      if (line === "selector:") section = "selector";
      else if (line === "casos:") section = "casos";
      else section = "root";
      currentCase = null;
      continue;
    }
    const [key, ...rest] = line.split(":");
    const val = rest.join(":").trim();
    if (section === "selector") {
      if (key === "modo") state.selector!.modo = val;
      else if (key === "lista") state.selector!.lista = val ? val.split(",").map((s) => s.trim()) : [];
    } else if (section === "casos") {
      if (indent === 2 && key && val === "") {
        // "C01:" abre un caso
        currentCase = key;
        state.casos![key] = { id: key, status: "pending" };
      } else if (currentCase && indent >= 4) {
        if (key === "status") state.casos![currentCase].status = val;
        else if (key === "area") state.casos![currentCase].area = val;
        else if (key === "id") state.casos![currentCase].id = val;
        else if (key === "innegociable") state.casos![currentCase].innegociable = val;
      }
    }
  }
  return state;
}

export default function misConfiguraciones(pi: ExtensionAPI) {
  pi.registerCommand("qa", {
    description: "Ejecutar QA de KOBRA Learning v1 (selector de casos)",
    handler: async (_args, ctx) => {
      const root = findProjectRoot(ctx.cwd);
      if (!root) {
        ctx.ui.notify(
          "No encontré qa/state/qa-state.yml. ¿Estás en un proyecto con la carpeta qa/?",
          "error",
        );
        return;
      }

      // Leer estado actual
      const statePath = path.join(root, "qa", "state", "qa-state.yml");
      let state: QaState;
      try {
        state = parseSimpleYaml(fs.readFileSync(statePath, "utf8"));
      } catch (e) {
        ctx.ui.notify(`No pude leer ${statePath}: ${(e as Error).message}`, "error");
        return;
      }

      const casos = state.casos ?? {};
      const pendientes = CASE_IDS.filter((id) => casos[id]?.status === "pending");
      const pass = CASE_IDS.filter((id) => casos[id]?.status === "pass");

      // Opciones del selector
      const options: string[] = [];
      const acciones: Array<{ tipo: "modo"; valor: string } | { tipo: "caso"; valor: string }> = [];

      if (pendientes.length > 0) {
        options.push(`▶ Correr pendientes (${pendientes.length}: ${pendientes.join(", ")})`);
        acciones.push({ tipo: "modo", valor: "solo_pendientes" });
      } else {
        options.push("✓ No hay casos pendientes");
        acciones.push({ tipo: "modo", valor: "solo_pendientes" });
      }
      options.push(`↻ Re-correr TODO (forzar, ${CASE_IDS.length} casos)`);
      acciones.push({ tipo: "modo", valor: "todos" });
      options.push("--- Casos individuales ---");
      for (const id of CASE_IDS) {
        const c = casos[id];
        const tag = c?.status === "pass" ? "✓" : c?.status === "pending" ? "○" : "•";
        const area = c?.area ? ` — ${c.area}` : c ? "" : " (sin definir)";
        options.push(`${tag} ${id}${area}`);
        acciones.push({ tipo: "caso", valor: id });
      }

      const elegido = await ctx.ui.select("QA KOBRA — ¿qué corrés?", options);
      if (!elegido) return;

      const idx = options.indexOf(elegido);
      if (idx < 0 || idx >= acciones.length) return;
      const accion = acciones[idx];

      // Aplicar el selector en qa-state.yml reescribiendo los campos relevantes.
      try {
        let yaml = fs.readFileSync(statePath, "utf8");
        const setModo = (modo: string) => {
          yaml = yaml.replace(/(selector:\s*\n\s*#?[^\n]*\n\s*#?[^\n]*\n?\s*modo:\s*)\w+/, `$1${modo}`);
          // fallback simple si no matchea por comentarios
          if (!/modo:\s*/.test(yaml) === false && !new RegExp(`modo: ${modo}`).test(yaml)) {
            yaml = yaml.replace(/^\s*modo:\s*\w+/m, `  modo: ${modo}`);
          }
        };
        if (accion.tipo === "modo") {
          setModo(accion.valor);
          // limpiar lista si modo no es "lista"
          yaml = yaml.replace(/^(\s*lista:\s*).*/m, `$1[]`);
        } else {
          // caso puntual: modo=lista + lista=[id]
          setModo("lista");
          yaml = yaml.replace(/^(\s*lista:\s*).*/m, `$1[${accion.valor}]`);
          // marcar ese caso como pending para que el dispatcher lo tome
          const re = new RegExp(`(${accion.valor}:\\s*\\n(?:\\s+[^\\n]*\\n)*?\\s+status:\\s*)\\w+`);
          if (re.test(yaml)) yaml = yaml.replace(re, `$1pending`);
        }
        fs.writeFileSync(statePath, yaml, "utf8");
      } catch (e) {
        ctx.ui.notify(`No pude actualizar qa-state.yml: ${(e as Error).message}`, "error");
        return;
      }

      // Inyectar al agente el prompt del dispatcher.
      const dispatcherPath = path.join(root, "qa", "dispatcher", "CORRER-QA.md");
      const dispatcherExiste = fs.existsSync(dispatcherPath);
      const prompt =
        (dispatcherExiste
          ? `Lee \`${path.relative(root, dispatcherPath)}\` y ejecútalo de punta a punta sin pedir confirmación. `
          : "") +
        `Proyecto raíz: ${root}. ` +
        `Ya actualicé qa/state/qa-state.yml con el selector elegido (${accion.tipo}=${accion.valor}). ` +
        `Sigue el dispatcher: lee el spec y el state, corre lo que corresponda, ` +
        `para cada caso sigue su protocolo en qa/protocolos/, captura evidencia en qa/evidencia/, ` +
        `regenera el PDF con el script de qa/scripts/, y actualiza qa/state/qa-state.yml al final. ` +
        `Reporta PASS/FAIL global + hallazgos al terminar.`;

      ctx.ui.notify(`QA: ${accion.tipo}=${accion.valor} — despachando al agente…`, "info");
      pi.sendUserMessage(prompt);
    },
  });
}
