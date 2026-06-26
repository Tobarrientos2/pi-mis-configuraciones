/**
 * agenda — agenda de tareas por día con agrupación IA (pi-mis-configuraciones)
 *
 * Comandos:
 *   /a <texto>           agrega una tarea para mañana (o "hoy"/"mañana"/"pasado"/YYYY-MM-DD)
 *                        Ej: /a mañana recibir correo de Patricia Stocker
 *                        El grupo lo decide el agente (LLM) leyendo el contexto de tu vida.
 *   /h-hoy               muestra las tareas de hoy, agrupadas
 *   /h-mañana            muestra las de mañana, agrupadas
 *   /h-semana            muestra las de los próximos 7 días, agrupadas
 *   /h-lista             muestra TODAS las pendientes
 *   /h-contexto          muestra la nota de contexto de tu vida
 *   /h-contexto <texto>  reemplaza la nota de contexto (leé "cómo la usa la IA" abajo)
 *   /h-done <id>         marca una tarea como hecha
 *
 * Persistencia: ~/.pi/agent/agenda.json  (sobrevive reinicios; no depende del agente).
 *
 * Cómo la IA agrupa: cuando usás /a, la extensión despacha al agente con un prompt
 * que le pide: (1) leer el contexto de tu vida con la tool agenda(action=contexto),
 * (2) decidir un 'grupo' (categoría tipo Trabajo/Patricia Stocker, Personal/Gimnasio),
 * (3) guardar la tarea con agenda(action=add, when, texto, grupo). Así, aunque la
 * extensión no llame al LLM por sí misma, el agente (que sí tiene LLM) hace la
 * clasificación usando el contexto que VOS le enseñaste en /h-contexto.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

const DATA_FILE = path.join(os.homedir(), ".pi", "agent", "agenda.json");

interface Tarea {
  id: number;
  when: string;       // YYYY-MM-DD
  text: string;
  grupo: string;      // categoría asignada por la IA
  done: boolean;
  created_at: string; // ISO
}
interface AgendaData {
  contexto: string;
  tareas: Tarea[];
  nextId: number;
}

const DEFAULT: AgendaData = {
  contexto:
    "## Mi vida (para que la IA agrupe bien mis tareas)\n" +
    "Acá anotás las cosas que le dan contexto a tu vida: tu empresa familiar, proyectos, " +
    "rutinas, cuentas clave. La IA lo usa para decidir el 'grupo' de cada tarea.\n\n" +
    "(Editá esto con /h-contexto <texto>).",
  tareas: [],
  nextId: 1,
};

// ---------- fechas ----------
const DIAS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseISO(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}
function prettyFecha(iso: string): string {
  const d = parseISO(iso);
  if (!d) return iso;
  return `${DIAS_ES[d.getDay()]} ${d.getDate()} de ${MESES_ES[d.getMonth()]}`;
}
/** Interpretar el prefijo de cuándo. Devuelve ISO YYYY-MM-DD o null si no calza. */
function parseWhen(prefijo: string, hoy: Date): string | null {
  const p = prefijo.toLowerCase().trim();
  if (p === "hoy" || p === "today") return toISO(hoy);
  if (p === "mañana" || p === "manana" || p === "tomorrow") {
    const d = new Date(hoy); d.setDate(d.getDate() + 1); return toISO(d);
  }
  if (p === "pasado" || p === "pasado mañana" || p === "pasadomanana") {
    const d = new Date(hoy); d.setDate(d.getDate() + 2); return toISO(d);
  }
  const iso = parseISO(p);
  if (iso) return toISO(iso);
  // día de la semana: el próximo tal día desde hoy
  const idx = DIAS_ES.indexOf(p);
  if (idx >= 0) {
    const hoyDia = hoy.getDay();
    let diff = (idx - hoyDia + 7) % 7;
    if (diff === 0) diff = 7; // próximo mismo día = próxima semana
    const d = new Date(hoy); d.setDate(d.getDate() + diff); return toISO(d);
  }
  return null;
}

// ---------- storage ----------
function loadData(): AgendaData {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const d = JSON.parse(raw) as Partial<AgendaData>;
    return {
      contexto: typeof d.contexto === "string" ? d.contexto : DEFAULT.contexto,
      tareas: Array.isArray(d.tareas) ? d.tareas : [],
      nextId: typeof d.nextId === "number" ? d.nextId : 1,
    };
  } catch {
    return { ...DEFAULT };
  }
}
function saveData(d: AgendaData): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), "utf8");
}

// ---------- utilidades de consulta ----------
function tareasPara(data: AgendaData, iso: string): Tarea[] {
  return data.tareas.filter((t) => t.when === iso && !t.done);
}
function tareasSemana(data: AgendaData, hoy: Date): Tarea[] {
  const out: Tarea[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(hoy); d.setDate(d.getDate() + i);
    out.push(...tareasPara(data, toISO(d)));
  }
  return out;
}
function agrupar(tareas: Tarea[]): Map<string, Tarea[]> {
  const m = new Map<string, Tarea[]>();
  for (const t of tareas) {
    const g = t.grupo || "Sin clasificar";
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(t);
  }
  return m;
}

// ---------- componente TUI para listar ----------
class AgendaList {
  private grupos: Map<string, Tarea[]>;
  private titulo: string;
  private theme: Theme;
  private onClose: () => void;
  private cachedW?: number;
  private cached?: string[];

  constructor(titulo: string, grupos: Map<string, Tarea[]>, theme: Theme, onClose: () => void) {
    this.titulo = titulo;
    this.grupos = grupos;
    this.theme = theme;
    this.onClose = onClose;
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) {
      this.onClose();
    }
  }
  render(width: number): string[] {
    if (this.cached && this.cachedW === width) return this.cached;
    const th = this.theme;
    const lines: string[] = [];
    lines.push("");
    const title = th.fg("accent", ` ${this.titulo} `);
    lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - this.titulo.length - 6))), width));
    lines.push("");
    let total = 0;
    for (const ts of this.grupos.values()) total += ts.length;
    lines.push(truncateToWidth(`  ${th.fg("muted", `${total} tarea(s) · agrupadas`)}`, width));
    lines.push("");
    if (total === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "Sin tareas para mostrar.")}`, width));
    } else {
      for (const [grupo, ts] of this.grupos) {
        lines.push(truncateToWidth(`  ${th.fg("accent", th.bold("▸ " + grupo))} ${th.fg("dim", `(${ts.length})`)}`, width));
        for (const t of ts) {
          const mark = th.fg("dim", "○");
          const texto = th.fg("text", t.text);
          lines.push(truncateToWidth(`      ${mark} ${th.fg("accent", `#${t.id}`)} ${texto}`, width));
        }
        lines.push("");
      }
    }
    lines.push(truncateToWidth(`  ${th.fg("dim", "Esc/Enter para cerrar")}`, width));
    lines.push("");
    this.cachedW = width;
    this.cached = lines;
    return lines;
  }
}

function mostrar(ctx: ExtensionContext, titulo: string, tareas: Tarea[]): void {
  if (!ctx.hasUI) {
    // fallback: notify multilínea
    const grupos = agrupar(tareas);
    let txt = `${titulo} (${tareas.length})`;
    for (const [g, ts] of grupos) {
      txt += `\n▸ ${g}`;
      for (const t of ts) txt += `\n   #${t.id} ${t.text}`;
    }
    ctx.ui.notify(txt, "info");
    return;
  }
  const grupos = agrupar(tareas);
  ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    return new AgendaList(titulo, grupos, theme, () => done());
  });
}

// ============================================================
// extensión
// ============================================================
export default function agendaExtension(pi: ExtensionAPI) {
  // ---------- tool `agenda` (la usa el agente cuando /a despacha) ----------
  pi.registerTool({
    name: "agenda",
    label: "Agenda",
    description:
      "Agenda personal de tareas por día. Actions: " +
      "list(when|hoy|mañana|semana|all) · add(when,text,grupo) · update(id,when?,text?,grupo?) · " +
      "toggle(id) · contexto_get · contexto_set(texto). `when` es YYYY-MM-DD o 'hoy'/'mañana'.",
    promptGuidelines: [
      "Usa la tool agenda cuando el usuario agregue o consulte tareas (/a, /h-*). " +
        "Para /a: primero lee el contexto con agenda(contexto_get), decidí un 'grupo' " +
        "corto (tipo 'Trabajo/Patricia Stocker') y llamá agenda(add) con when, text y grupo.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("update"),
        Type.Literal("toggle"),
        Type.Literal("contexto_get"),
        Type.Literal("contexto_set"),
      ]),
      when: Type.Optional(Type.String({ description: "YYYY-MM-DD | 'hoy' | 'mañana' | 'semana' | 'all'" })),
      text: Type.Optional(Type.String()),
      grupo: Type.Optional(Type.String()),
      id: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const data = loadData();
      const hoy = new Date();
      switch (params.action) {
        case "list": {
          const w = (params.when || "all") as string;
          let res: Tarea[];
          if (w === "hoy") res = tareasPara(data, toISO(hoy));
          else if (w === "mañana" || w === "manana") {
            const d = new Date(hoy); d.setDate(d.getDate() + 1);
            res = tareasPara(data, toISO(d));
          } else if (w === "semana") res = tareasSemana(data, hoy);
          else res = data.tareas.filter((t) => !t.done);
          const txt = res.map((t) => `#${t.id} [${t.when}] ${t.grupo} — ${t.text}`).join("\n") || "(ninguna)";
          return { content: [{ type: "text", text: txt }], details: { count: res.length } };
        }
        case "add": {
          if (!params.text) return errOk("falta 'text'");
          const when = params.when ?? "mañana";
          const iso = when === "hoy" ? toISO(hoy) :
            (when === "mañana" || when === "manana") ? toISO(new Date(hoy.getTime() + 86400000)) :
            parseISO(when) ? when : parseISO(when.replace(/-/g, "")) ? when : null;
          if (!iso) return errOk(`when inválido: ${when}. Usá YYYY-MM-DD | hoy | mañana`);
          const grupo = params.grupo?.trim() || "Sin clasificar";
          const t: Tarea = {
            id: data.nextId++,
            when: iso,
            text: params.text.trim(),
            grupo,
            done: false,
            created_at: new Date().toISOString(),
          };
          data.tareas.push(t);
          saveData(data);
          return { content: [{ type: "text", text: `✓ Agendada #${t.id} para ${prettyFecha(iso)} · grupo: ${grupo}\n   ${t.text}` }], details: { id: t.id } };
        }
        case "toggle": {
          if (params.id === undefined) return errOk("falta 'id'");
          const t = data.tareas.find((x) => x.id === params.id);
          if (!t) return errOk(`no existe #${params.id}`);
          t.done = !t.done;
          saveData(data);
          return { content: [{ type: "text", text: `#${t.id} ${t.done ? "hecha ✓" : "reabierta"}: ${t.text}` }], details: { id: t.id } };
        }
        case "update": {
          if (params.id === undefined) return errOk("falta 'id'");
          const t = data.tareas.find((x) => x.id === params.id);
          if (!t) return errOk(`no existe #${params.id}`);
          const cambios: string[] = [];
          if (params.when !== undefined && params.when.trim()) {
            const when = params.when.trim();
            const iso = when === "hoy" ? toISO(hoy) :
              (when === "mañana" || when === "manana") ? toISO(new Date(hoy.getTime() + 86400000)) :
              parseISO(when) ? when : null;
            if (!iso) return errOk(`when inválido: ${when}`);
            t.when = iso;
            cambios.push(`when=${iso}`);
          }
          if (params.text !== undefined && params.text.trim()) {
            t.text = params.text.trim();
            cambios.push(`text actualizado`);
          }
          if (params.grupo !== undefined && params.grupo.trim()) {
            t.grupo = params.grupo.trim();
            cambios.push(`grupo=${t.grupo}`);
          }
          if (cambios.length === 0) return errOk("no especficiaste qué cambiar (when/text/grupo)");
          saveData(data);
          return { content: [{ type: "text", text: `✓ #${t.id} actualizada: ${cambios.join(", ")}\n   ahora: [${t.when}] ${t.grupo} — ${t.text}` }], details: { id: t.id } };
        }
        case "contexto_get":
          return { content: [{ type: "text", text: data.contexto }], details: {} };
        case "contexto_set": {
          if (!params.text) return errOk("falta 'text' (el nuevo contexto)");
          data.contexto = params.text;
          saveData(data);
          return { content: [{ type: "text", text: "✓ Contexto actualizado." }], details: {} };
        }
        default:
          return errOk(`acción desconocida: ${params.action}`);
      }
    },
  });

  function errOk(msg: string) {
    return { content: [{ type: "text", text: `Error: ${msg}` }], details: { error: msg } };
  }

  // ---------- /a ----------
  pi.registerCommand("a", {
    description: "Agregar tarea (mañana por defecto): /a <texto>",
    handler: async (args, ctx) => {
      const a = (args || "").trim();
      if (!a) {
        ctx.ui.notify("Uso: /a <texto>  (opcional: 'hoy'/'mañana'/'pasado'/YYYY-MM-DD al inicio)", "info");
        return;
      }
      // intentar separar prefijo de 'when'
      const tokens = a.split(/\s+/);
      const hoy = new Date();
      let whenIso = toISO(new Date(hoy.getTime() + 86400000)); // default: mañana
      let whenLabel = "mañana";
      if (tokens.length > 1) {
        const pref = parseWhen(tokens[0], hoy);
        if (pref) {
          whenIso = pref;
          whenLabel = tokens[0].toLowerCase();
          tokens.shift();
        }
      }
      const texto = tokens.join(" ").trim();
      if (!texto) {
        ctx.ui.notify("Falta el texto de la tarea.", "error");
        return;
      }
      // despachar al agente: él decide el grupo con su LLM leyendo el contexto.
      const prompt =
        `Agregá una tarea a mi agenda personal usando la tool \`agenda\` con action=add.\n` +
        `- when: "${whenIso}" (mañana en calendario)\n` +
        `- text: "${texto.replace(/"/g, '\\"')}"\n` +
        `Antes de llamarla, hacé una vez \`agenda(action=contexto_get)\` para leer la nota sobre mi vida ` +
        `(ahí anoté cosas como mi empresa familiar Patricia Stocker, proyectos, rutinas) y usala para ` +
        `decidir un \`grupo\` corto y útil tipo "Trabajo/Patricia Stocker", "Personal/Gimnasio", ` +
        `"Finanzas", "Familia". Si no tenés info, usá grupo "Sin clasificar". ` +
        `Después de agregar, confirmame en una línea: id, fecha, grupo y texto. No hagas nada más.`;
      ctx.ui.notify(`Agendando para ${prettyFecha(whenIso)}: "${texto}" (el agente va a clasificar el grupo)`, "info");
      pi.sendUserMessage(prompt);
    },
  });

  // ---------- /h-hoy, /h-mañana, /h-semana, /h-lista ----------
  function listar(titulo: string, iso: string | null, semana: boolean, todas: boolean) {
    return async (_args: string, ctx: ExtensionContext) => {
      const data = loadData();
      const hoy = new Date();
      let ts: Tarea[];
      if (todas) ts = data.tareas.filter((t) => !t.done);
      else if (semana) ts = tareasSemana(data, hoy);
      else ts = tareasPara(data, iso!);
      if (!ctx.hasUI) {
        ctx.ui.notify(`${titulo}: ${ts.length} tarea(s)`, "info");
      }
      mostrar(ctx, titulo, ts);
    };
  }
  pi.registerCommand("h-hoy", {
    description: "Tareas de hoy (agrupadas)",
    handler: listar("Hoy", toISO(new Date()), false, false),
  });
  pi.registerCommand("h-mañana", {
    description: "Tareas de mañana (agrupadas)",
    handler: (() => {
      const hoy = new Date();
      const d = new Date(hoy); d.setDate(d.getDate() + 1);
      return listar("Mañana", toISO(d), false, false);
    })(),
  });
  pi.registerCommand("h-semana", {
    description: "Tareas de los próximos 7 días (agrupadas)",
    handler: listar("Esta semana", null, true, false),
  });
  pi.registerCommand("h-lista", {
    description: "Todas las pendientes (agrupadas)",
    handler: listar("Todas las pendientes", null, false, true),
  });

  // ---------- /a-list ----------
  // Selector interactivo de tareas pendientes. Al elegir una, abre un input
  // pre-llenado con su info para que el usuario le diga a la IA qué cambiar,
  // y despacha el pedido de modificación con todo el contexto pegado.
  pi.registerCommand("a-list", {
    description: "Seleccionar una tarea pendiente para editarla",
    handler: async (_args, ctx) => {
      const data = loadData();
      const pendientes = data.tareas.filter((t) => !t.done).sort((a, b) => {
        // ordenar por fecha ascendente
        if (a.when !== b.when) return a.when < b.when ? -1 : 1;
        return a.id - b.id;
      });
      if (pendientes.length === 0) {
        ctx.ui.notify("No hay tareas pendientes. Agregá una con /a <texto>", "info");
        return;
      }
      // opciones del selector: una línea por tarea, con id/fecha/grupo/texto
      const options = pendientes.map((t) => {
        const fecha = prettyFecha(t.when);
        const head = `#${t.id} · ${fecha} · ${t.grupo}`;
        const txt = t.text.length > 50 ? t.text.slice(0, 47) + "…" : t.text;
        return `${head}\n    ${txt}`;
      });
      const elegido = await ctx.ui.select("¿Qué tarea querés cambiar?", options);
      if (!elegido) return;
      const idx = options.indexOf(elegido);
      if (idx < 0 || idx >= pendientes.length) return;
      const t = pendientes[idx];

      // input pre-llenado con un pedido de cambio" natural" para la IA
      const prefilled = `Cambiar la tarea #${t.id} (${prettyFecha(t.when)} · ${t.grupo}): ${t.text}`;
      const instruccion = await ctx.ui.input(
        `¿Qué querés cambiar de la tarea #${t.id}? (ej: "pasar al viernes", "cambiar el texto a ...", "marcar como hecho")`,
        prefilled,
      );
      if (!instruccion || !instruccion.trim()) {
        ctx.ui.notify("Cancelado (sin cambios).", "info");
        return;
      }

      // despachar al agente con el contexto completo: la tarea + lo que pidió el
      // usuario. La IA decide qué tools de `agenda` usar (toggle si pidió marcar
      // hecha, o add si pidió mover/cambiar texto... el modelo interpreta).
      const prompt =
        `El usuario quiere modificar una tarea de la agenda. Tarea actual (leída de ~/.pi/agent/agenda.json):
` +
        `- id: ${t.id}\n- when: ${t.when} (${prettyFecha(t.when)})\n- grupo: ${t.grupo}\n- text: "${t.text}"\n- done: ${t.done}\n\n` +
        `Pedido del usuario: "${instruccion}".\n\n` +
        `Usá la tool \`agenda\` para aplicar el cambio. Interpretá el pedido de forma natural:\n` +
        `- Si pide mover de fecha ("al viernes", "para pasado", "para YYYY-MM-DD") → agenda(action=update, id=${t.id}, when=<nueva fecha YYYY-MM-DD>). Convertí días de la semana o 'hoy'/'mañana'/'pasado' a la fecha concreta YYYY-MM-DD.\n` +
        `- Si pide marcar como hecho → agenda(action=toggle, id=${t.id}).\n` +
        `- Si pide cambiar el texto o el grupo → agenda(action=update, id=${t.id}, text=<nuevo texto>, grupo=<nuevo grupo>). Actualizá solo lo que pidió.\n` +
        `Después de aplicar, confirmame en una línea qué quedó. No hagas nada más.`;
      ctx.ui.notify(`Editando #${t.id} → despachando al agente…`, "info");
      pi.sendUserMessage(prompt);
    },
  });

  // ---------- /h-contexto ----------
  pi.registerCommand("h-contexto", {
    description: "Ver o setear la nota de contexto de tu vida",
    handler: async (args, ctx) => {
      const data = loadData();
      const a = (args || "").trim();
      if (!a) {
        if (!ctx.hasUI) { ctx.ui.notify(data.contexto, "info"); return; }
        ctx.ui.custom<void>((_tui, theme, _kb, done) => {
          // componente simple de texto
          const comp = {
            handleInput(d: string) { if (matchesKey(d, "escape") || matchesKey(d, "enter") || matchesKey(d, "ctrl+c")) done(); },
            render(width: number): string[] {
              const lines: string[] = ["", theme.fg("accent", ` Contexto de mi vida `), ""];
              for (const ln of data.contexto.split("\n")) {
                lines.push(truncateToWidth(`  ${theme.fg("text", ln)}`, width));
              }
              lines.push("", theme.fg("dim", "  Esc para cerrar"), "");
              return lines;
            },
          };
          return comp;
        });
        return;
      }
      data.contexto = a.startsWith("file:") ? fs.readFileSync(a.slice(5), "utf8") : a;
      saveData(data);
      ctx.ui.notify("✓ Contexto actualizado. Ahora /a lo usa para agrupar.", "info");
    },
  });

  // ---------- /h-done ----------
  pi.registerCommand("h-done", {
    description: "Marcar tarea hecha por id",
    handler: async (args, ctx) => {
      const id = Number((args || "").trim());
      if (!id) { ctx.ui.notify("Uso: /h-done <id>", "info"); return; }
      const data = loadData();
      const t = data.tareas.find((x) => x.id === id);
      if (!t) { ctx.ui.notify(`No existe #${id}`, "error"); return; }
      t.done = true;
      saveData(data);
      ctx.ui.notify(`✓ #${id} hecha: ${t.text}`, "info");
    },
  });
}

// ayudante para el render del contexto en TUI (Text no se usa acá pero evita warning de import)
export const _Text = Text;
