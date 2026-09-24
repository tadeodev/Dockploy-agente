# Dockploy Agent

Agente en **tu ordenador**. No abre puertos. Un agente activo por cuenta.

## Cómo usarlo

**Recomendado:** entra con tu usuario de Dockploy. El token del equipo se genera solo y, si deja de valer, el agente lo vuelve a pedir al backend.

```bash
cd ~/Dockploy-agente
npm install
npm run build
node dist/index.js login https://dockployback.gaolania.com.es TU_EMAIL TU_CONTRASEÑA
node dist/index.js start
```

`start` deja el agente **en segundo plano**: puedes cerrar la terminal y los túneles siguen abiertos. Para pararlo, `node dist/index.js stop` (los túneles publicados dejan de responder).

No guarda la contraseña ni la sesión. Guarda solo el token de equipo. El `dcp_...` del panel **no caduca** por tiempo: solo deja de valer si revocas el equipo o si `login` genera uno nuevo. Si deja de valer, hay que volver a hacer `login`.

También puedes copiar el `dcp_...` del panel (**Túneles locales → Registrar equipo**) y usar `configure` como hasta ahora.

Si compartes un front que se construye (Vite, React…), no publiques `npm run dev`. Haz `npm run build` y `npm run preview -- --host 127.0.0.1 --port 4173`, y en el panel indica el **4173**. El modo desarrollo suele verse en blanco detrás del túnel.

El token `dcp_...` solo se muestra esa vez. No es el de Cloudflare. No lo envíes por chat.

## Si ya cerraste la ventana

Vuelve a registrar no se puede si ya tienes un agente. Si aún tienes el token:

```bash
cd ~/Dockploy-agente
node dist/index.js configure https://dockployback.gaolania.com.es dcp_TU_TOKEN
node dist/index.js start
```

Si no lo guardaste, revoca el equipo (sin túneles activos) y registra de nuevo: el panel vuelve a mostrar los comandos.

## Segundo plano, parar y ver qué hace

```bash
node dist/index.js start     # arranca y libera la terminal
node dist/index.js status    # dice si está funcionando y con qué PID
node dist/index.js logs      # últimas 50 líneas del registro (logs 200 para más)
node dist/index.js stop      # lo detiene y cierra los túneles
node dist/index.js run       # primer plano: ocupa la terminal, se corta al cerrarla
```

Ficheros en `~/.dockploy-agent/` (Windows: `%USERPROFILE%\.dockploy-agent\`): `config.json`, `agent.pid`, `agent.log` y `update.json`.

## Actualizarlo

**No tienes que hacer nada.** Cuando Dockploy empieza a pedir una versión más nueva,
el agente se descarga el cambio, se recompila y se reinicia solo. Lo verás en `logs`.

Solo instala el commit que GitHub tiene firmado en `main` de
`tadeodev/Dockploy-agente`. Si el remoto apunta a otro sitio, o el commit no
está firmado, la actualización se detiene y sigue con la versión que ya corre.
Tampoco arranca si esa copia tiene cambios sin subir o commits que no están en `main`.
`npm ci` no ejecuta scripts de instalación de dependencias.

Si quieres forzarlo, este comando funciona **desde cualquier carpeta**:

```bash
dockploy-agent update
```

Si sale `command not found`, es que el comando no está en el PATH. Déjalo puesto una
vez, desde la carpeta donde clonaste el agente (no tiene que ser el home):

```bash
npm link
```

También vale llamar al fichero con su ruta completa, sea la que sea:
`node /ruta/a/Dockploy-agente/dist/index.js update`.

Si tienes cambios locales sin guardar en esa carpeta, la actualización se detiene y
te avisa, para no pisártelos. Si la compilación falla, el agente sigue con la
versión anterior en lugar de quedarse a medias.

El agente sobrevive a cerrar la terminal, pero **no** a apagar o suspender el ordenador ni a quedarte sin internet. Al volver a encender, arráncalo otra vez con `start` (o usa el servicio de abajo para que lo haga solo).

## Dejarlo siempre activo (Linux)

`/etc/systemd/system/dockploy-agent.service`:

```ini
[Unit]
Description=Dockploy Local Agent
After=network-online.target

[Service]
Type=simple
User=USUARIO_LOCAL
ExecStart=/usr/local/bin/dockploy-agent run
Restart=always
RestartSec=5
Environment=HOME=/home/USUARIO_LOCAL

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dockploy-agent
```

El servicio usa `run` a propósito: quien vigila el proceso es systemd, no hace falta `start`.

## Dejarlo siempre activo (macOS)

`~/Library/LaunchAgents/com.dockploy.agent.plist`, cambiando `TU_USUARIO` y la ruta de `node` (`which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dockploy.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/TU_USUARIO/Dockploy-agente/dist/index.js</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/TU_USUARIO/.dockploy-agent/agent.log</string>
  <key>StandardErrorPath</key><string>/Users/TU_USUARIO/.dockploy-agent/agent.log</string>
</dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.dockploy.agent.plist
```

Para quitarlo: `launchctl unload -w ~/Library/LaunchAgents/com.dockploy.agent.plist`.

## Problemas

- **permission denied / command not found:** no uses `sudo`. `node dist/index.js login …` o `configure` y `start`.
- **Invalid connector token:** `node dist/index.js login https://dockployback.gaolania.com.es EMAIL CONTRASEÑA` y vuelve a `start`.
- **Offline en el panel:** mira `node dist/index.js status`; si está parado, `start`. Si dice que funciona, `node dist/index.js logs` te cuenta qué falla.
- **"Ya hay un agente en segundo plano":** `node dist/index.js stop` antes de volver a arrancar.
- **No hay aplicación escuchando:** abre `http://127.0.0.1:PUERTO` en este PC.
- **Host / CORS:** permite el dominio público en tu app.
- Otro PC: cierra túneles, **Revocar equipo**, registra de nuevo y copia lo que muestre el panel.
