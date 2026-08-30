# Dockploy Agent

Agente en **tu ordenador**. No abre puertos. Un agente activo por cuenta.

API de Dockploy: `https://dockployback.gaolania.com.es`  
Token: el `dcp_...` de **Túneles locales** → Registrar equipo (una sola vez). No es el de Cloudflare.

## Copiar y pegar (macOS)

```bash
brew install cloudflared
git clone https://github.com/tadeodev/Dockploy-agente.git
cd Dockploy-agente
npm install
npm run build
npm link
cloudflared --version
dockploy-agent
```

En Dockploy, registra el equipo y copia el token. Sustituye `dcp_PEGA_EL_TOKEN` y pega:

```bash
dockploy-agent configure https://dockployback.gaolania.com.es dcp_PEGA_EL_TOKEN
dockploy-agent run
```

Deja esa terminal abierta. El equipo debe pasar a **Online**. Luego arranca tu app, comprueba `http://127.0.0.1:PUERTO` y en el panel pulsa **Publicar**.

```bash
dockploy-agent status
```

Config: `~/.dockploy-agent/config.json`

## Windows

```powershell
winget install --id Cloudflare.cloudflared
git clone https://github.com/tadeodev/Dockploy-agente.git
cd Dockploy-agente
npm install
npm run build
npm link
dockploy-agent configure https://dockployback.gaolania.com.es dcp_PEGA_EL_TOKEN
dockploy-agent run
```

Linux: instala [cloudflared](https://pkg.cloudflare.com/index.html) y el mismo `git clone` … `npm link`. En `npm link` puede hacer falta `sudo`.

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

- **Offline:** `dockploy-agent run` tiene que seguir. La URL es `https://dockployback.gaolania.com.es`, no el frontend.
- **No hay aplicación escuchando:** abre `http://127.0.0.1:PUERTO` en este PC.
- **Host / CORS:** permite el dominio público en tu app.
- No envíes el token `dcp_...` por chat. Un agente por cuenta: para otro PC, revoca el equipo en el panel.
