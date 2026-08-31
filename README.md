# Dockploy Agent

Agente en **tu ordenador**. No abre puertos. Un agente activo por cuenta.

## Cómo usarlo

**Recomendado:** entra con tu usuario de Dockploy. El token del equipo se genera solo y, si deja de valer, el agente lo vuelve a pedir al backend.

```bash
cd ~/Dockploy-agente
npm install
npm run build
node dist/index.js login https://dockployback.gaolania.com.es TU_EMAIL TU_CONTRASEÑA
node dist/index.js run
```

No guarda la contraseña; guarda un token de equipo y la sesión para poder renovarlo. El `dcp_...` del panel **no caduca** por tiempo: solo deja de valer si revocas el equipo o si `login` genera uno nuevo.

También puedes copiar el `dcp_...` del panel (**Túneles locales → Registrar equipo**) y usar `configure` como hasta ahora.

Si compartes un front que se construye (Vite, React…), no publiques `npm run dev`. Haz `npm run build` y `npm run preview -- --host 127.0.0.1 --port 4173`, y en el panel indica el **4173**. El modo desarrollo suele verse en blanco detrás del túnel.

El token `dcp_...` solo se muestra esa vez. No es el de Cloudflare. No lo envíes por chat.

## Si ya cerraste la ventana

Vuelve a registrar no se puede si ya tienes un agente. Si aún tienes el token:

```bash
cd ~/Dockploy-agente
node dist/index.js configure https://dockployback.gaolania.com.es dcp_TU_TOKEN
node dist/index.js run
```

Si no lo guardaste, revoca el equipo (sin túneles activos) y registra de nuevo: el panel vuelve a mostrar los comandos.

Config: `~/.dockploy-agent/config.json` (Windows: `%USERPROFILE%\.dockploy-agent\config.json`).

```bash
node dist/index.js status
```

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

## Problemas

- **permission denied / command not found:** no uses `sudo`. `node dist/index.js login …` o `configure` y `run`.
- **Invalid connector token:** `node dist/index.js login https://dockployback.gaolania.com.es EMAIL CONTRASEÑA` y vuelve a `run`. El agente renueva el token si aún tiene sesión.
- **Offline:** `node dist/index.js run` (o `dockploy-agent run`) tiene que seguir.
- **No hay aplicación escuchando:** abre `http://127.0.0.1:PUERTO` en este PC.
- **Host / CORS:** permite el dominio público en tu app.
- Otro PC: cierra túneles, **Revocar equipo**, registra de nuevo y copia lo que muestre el panel.
