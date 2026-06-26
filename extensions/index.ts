/**
 * mis-configuraciones — Extensión de pi
 *
 * Comando /qa: arranca QA de KOBRA Learning v1 con selector interactivo.
 * Lee qa/state/qa-state.yml del proyecto y deja que el usuario elija:
 *   - Todos los pendientes
 *   - Re-correr todo (fuerza)
 *   - Un caso puntual (C01..C09)
 *
 * Al elegir, reescribe qa-state.yml de forma robusta (línea por línea, sin regex
 * frágil) con el selector aplicado. En el caso de un caso puntual, además marca
 * ese caso como status=pending para que el dispatcher lo tome automáticamente.
 *
 * Luego inyecta al agente el dispatcher (qa/dispatcher/CORRER-QA.md) reforzando
 * los requisitos obligatorios: screenshots con ego-browser en los nombres
 * exactos del protocolo (qa/evidencia/{nuevo,antiguo}/), generación del PDF con
 * el script del caso, y actualización de qa-state.yml al final.
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
  status: string;
}
interface QaState {
  modo: string;
  lista: string[];
  casos: Record<string, CaseState>;
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

/** Parser de YAML chico (solo lo que usa qa-state.yml). */
function parseSimpleYaml(text: string): QaState {
  const state: QaState = { modo: "solo_pendientes", lista: [], casos: {} };
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
      if (key === "modo") state.modo = val;
      else if (key === "lista") {
        const m = val.match(/\[([^\]]*)\]/);
        state.lista = m && m[1].trim() ? m[1].split(",").map((s) => s.trim()) : [];
      }
    } else if (section === "casos") {
      if (indent === 2 && val === "") {
        currentCase = key;
        state.casos[key] = { id: key, status: "pending" };
      } else if (currentCase && indent >= 4) {
        if (key === "status") state.casos[currentCase].status = val;
        else if (key === "area") state.casos[currentCase].area = val;
        else if (key === "id") state.casos[currentCase].id = val;
      }
    }
  }
  return state;
}

/**
 * Reescritura segura de qa-state.yml: opera línea por línea y valida cada cambio.
 * Lanza error si algún campo esperado no se encuentra (así nunca escribe a medias).
 */
function patchStateYaml(original: string, opts: {
  modo: string;
  lista?: string[];      // si se pasa, escribe `lista: [...]`
  markCasePending?: string; // si se pasa, pone ese caso en status=pending
}): string {
  const lines = original.split("\n");

  const setField = (key: "modo" | "lista", value: string): boolean => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(  )([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (m && m[2] === key) {
        lines[i] = `  ${key}: ${value}`;
        return true;
      }
    }
    return false;
  };

  if (!setField("modo", opts.modo)) {
    throw new Error("no encontré el campo 'modo:' bajo el bloque selector:");
  }

  if (opts.lista !== undefined) {
    if (!setField("lista", opts.lista.length ? `[${opts.lista.join(",")}]` : "[]")) {
      throw new Error("no encontré el campo 'lista:' bajo el bloque selector:");
    }
  }

  if (opts.markCasePending) {
    const cid = opts.markCasePending;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(/^(  )([A-Za-z0-9]+):\s*$/);
      if (head && head[2] === cid) {
        for (let j = i + 1; j < lines.length; j++) {
          const sib = lines[j].match(/^(  )([A-Za-z0-9_]+):\s*$/);
          if (sib) break; // otro caso top-level, salir
          const sm = lines[j].match(/^(    )status:\s*(\w+).*$/);
          if (sm) {
            lines[j] = `    status: pending`;
            found = true;
            break;
          }
        }
        break;
      }
    }
    if (!found) throw new Error(`no encontré el caso ${cid} con campo 'status:' dentro de casos:`);
  }

  return lines.join("\n");
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

      // Reescribir qa-state.yml con el selector elegido.
      // Política: si elegiste un caso puntual, se marca pending automáticamente
      // (así el dispatcher lo toma sin depender del agente).
      try {
        const original = fs.readFileSync(statePath, "utf8");
        const patched = accion.tipo === "caso"
          ? patchStateYaml(original, {
              modo: "lista",
              lista: [accion.valor],
              markCasePending: accion.valor,
            })
          : patchStateYaml(original, { modo: accion.valor, lista: [] });
        fs.writeFileSync(statePath, patched, "utf8");
        const desc = accion.tipo === "caso"
          ? `modo=lista, lista=[${accion.valor}], ${accion.valor}:status=pending`
          : `modo=${accion.valor}, lista=[]`;
        ctx.ui.notify(`qa-state.yml actualizado: ${desc}`, "info");
      } catch (e) {
        ctx.ui.notify(`No pude actualizar qa-state.yml: ${(e as Error).message}`, "error");
        return;
      }

      // Despachar al agente. Reforzamos los requisitos obligatorios para que el
      // agente no se salte: screenshots con ego-browser en los nombres del
      // protocolo, generación del PDF, y actualización del state al final.
      const dispatcherPath = path.join(root, "qa", "dispatcher", "CORRER-QA.md");
      const dispatcherExiste = fs.existsSync(dispatcherPath);
      const dispatcherRef = dispatcherExiste
        ? `\`${path.relative(root, dispatcherPath)}\``
        : "el dispatcher (qa/dispatcher/CORRER-QA.md)";
      const casosAcorrer =
        accion.tipo === "caso"
          ? `[${accion.valor}]`
          : accion.valor === "todos"
            ? "todos los casos (C01..C09)"
            : "los casos con status=pending";
      const prompt =
        `Lee ${dispatcherRef} y ejecútalo de punta a punta sin pedir confirmación hasta terminar todos los casos seleccionados (${casosAcorrer}). ` +
        `Proyecto raíz: ${root}. ` +
        `Ya dejé qa/state/qa-state.yml con el selector elegido (${accion.tipo}=${accion.valor}). ` +
        `\n\n` +
        `REQUISITOS OBLIGATORIOS por cada caso que corras (no los saltes):\n` +
        `1. **Protocolo:** antes de tocar, abre qa/protocolos/PROTOCOLO-QA-<id>.md y sigue sus checkpoints letra por letra (un checkpoint = un screenshot). Verifica con qa/protocolos/PROTOCOLO-QA-MAESTRO.md qué protocolo + script le corresponde al caso; si el protocolo dice _(pendiente)_, DETENTE y reporta que falta redactarlo (no inventes pasos).\n` +
        `2. **Ego-browser screenshots:** usa el skill ego-browser para interactuar con los servers ANTES (http://127.0.0.1:8091) y DESPUÉS (http://127.0.0.1:8090). Cada checkpoint del protocolo nombra EXACTAMENTE qué screenshot capturar y en qué carpeta guardarlo: qa/evidencia/antiguo/ para 8091 y qa/evidencia/nuevo/ para 8090. Respeta esos nombres, no los inventes. Para sub-casos por API, guarda los JSON en qa/evidencia/{nuevo,antiguo}/api/. Si un servidor no responde 200, levántalo según el dispatcher antes de empezar.\n` +
        `3. **Reporte PDF:** al terminar cada caso, ejecuta su script (qa/scripts/gen_reporte_<id_lower>.py, ej. gen_reporte_c01.py) que junta TODAS las screenshots capturadas y arma el PDF en qa/reportes/Reporte-QA-<id>-KOBRA.pdf (sobre-escribe el existente). Si usaste nombres de screenshot distintos a los del script, actualízalo antes de correrlo.\n` +
        `4. **Estado:** al terminar cada caso escribe en qa/state/qa-state.yml el status final (pass|fail|blocked), suma 1 a intentos, actualiza ultima_vez (ISO 8601) y hallazgos (cantidad). Nunca dejes un caso en 'running'.\n` +
        `\nReporta al final: PASS/FAIL global (cuenta) + lista de hallazgos (con archivo:línea) + paths a los PDFs generados.`;

      ctx.ui.notify(`QA: ${accion.tipo}=${accion.valor} — despachando al agente…`, "info");
      pi.sendUserMessage(prompt);
    },
  });
}
