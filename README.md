# pi-mis-configuraciones

Paquete de **pi** con el comando `/qa` para correr QA de **KOBRA Learning v1** con
selector interactivo de casos.

## Qué hace

El comando `/qa`:

1. Lee `qa/state/qa-state.yml` del proyecto para listar los casos (C01–C09) y su estado.
2. Abre un selector en el TUI con opciones:
   - ▶ Correr pendientes
   - ↻ Re-correr TODO (forzar)
   - cada caso individual (✓ pass · ○ pending · • otro)
3. Actualiza `qa/state.yml` con el selector elegido (`modo: solo_pendientes | todos | lista`).
4. Inyecta al agente el prompt del dispatcher (`qa/dispatcher/CORRER-QA.md`), que ya sabe
   qué correr leyendo el state.

**No duplica lógica**: todo el know-how (qué es cada caso, cómo se ejecuta letra por
letra, cómo se arma el PDF) vive en la carpeta `qa/` del proyecto. La extensión solo
**orchestra**: lee estado, te deja elegir, y dispara el dispatcher.

## Requisitos en el proyecto

La carpeta del proyecto donde se ejecuta `/qa` debe tener la estructura `qa/`:

```
qa/
├── spec/qa-session.yml          # los 9 casos (spec, inmutable)
├── contexto/PROMPT-IA-QA.md
├── dispatcher/CORRER-QA.md      # el dispatcher que el /qa dispara
├── protocolos/                  # un PROTOCOLO-QA-CXX.md por caso
├── state/qa-state.yml           # estado (se reescribe: pass/pending/…)
├── evidencia/{nuevo,antiguo}/
├── reportes/
└── scripts/                     # gen_reporte_cXX.py
```

## Instalación

### Desde GitHub (tobarrientos2)

```bash
pi install git:github.com/tobarrientos2/pi-mis-configuraciones
```

O probar sin instalar:

```bash
pi -e git:github.com/tobarrientos2/pi-mis-configuraciones
```

### Local (desarrollo)

```bash
pi install ./pi-mis-configuraciones
```

Después, dentro de un proyecto con carpeta `qa/`, escribe `/qa` y Enter.

## Publicar en GitHub

```bash
cd pi-mis-configuraciones
git init
git add .
git commit -m "feat: comando /qa con selector de casos"
git branch -M main
git remote add origin git@github.com:tobarrientos2/pi-mis-configuraciones.git
git push -u origin main
# tag para fijar versión (opcional, pinnea updates)
git tag v0.1.0 && git push origin v0.1.0
```

Luego cualquiera puede instalar con:

```bash
pi install git:github.com/tobarrientos2/pi-mis-configuraciones@v0.1.0
```

## Cómo extender

- **Agregar casos C10+**: se agregan a `qa/spec/qa-session.yml` y `qa/state/qa-state.yml`
  con `status: pending`; el comando los lista automáticamente (lee el state). No hace
  falta tocar la extensión mientras los IDs sigan el patrón `C\d+`.
- **Otras configuraciones personales**: agregá más `pi.registerCommand(...)` en
  `extensions/index.ts`. El paquete se llama "mis-configuraciones" justamente para que
  acá vivan otros comandos tuyos (/qa, /deploy, lo que sea).
