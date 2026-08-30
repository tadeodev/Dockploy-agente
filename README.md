# Dockploy Agent

Agente en **tu ordenador**. No abre puertos. Un agente activo por cuenta.

## Cómo usarlo

Todo lo que necesitas te lo da el **panel de Dockploy**. No hace falta inventar la URL ni el token.

1. Entra en Dockploy → **Túneles locales**.
2. **Registrar equipo** (nombre, por ejemplo `MacBook de Ana`).
3. Se abre una ventana con los comandos ya rellenados. Cópialos tal cual.
4. **No uses `sudo`.** Si `dockploy-agent` da *permission denied*, desde esta carpeta:

```bash
node dist/index.js configure https://dockployback.gaolania.com.es dcp_TU_TOKEN
node dist/index.js run
```
5. Deja `node dist/index.js run` abierto. Cuando el equipo esté **Online**, arranca tu app y pulsa **Publicar**.

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

- **permission denied / command not found:** no uses `sudo` (cambia el PATH). En la carpeta del repo: `node dist/index.js configure …` y `node dist/index.js run`. Si hiciste `npm link`, `chmod +x dist/index.js` y vuelve a `npm link`.
- **Offline:** `node dist/index.js run` (o `dockploy-agent run`) tiene que seguir.
- **No hay aplicación escuchando:** abre `http://127.0.0.1:PUERTO` en este PC.
- **Host / CORS:** permite el dominio público en tu app.
- Otro PC: cierra túneles, **Revocar equipo**, registra de nuevo y copia lo que muestre el panel.
