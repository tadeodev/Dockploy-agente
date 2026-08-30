# Dockploy Agent

Agente en **tu ordenador**. No abre puertos. Un agente activo por cuenta.

## Cómo usarlo

Todo lo que necesitas te lo da el **panel de Dockploy**. No hace falta inventar la URL ni el token.

1. Entra en Dockploy → **Túneles locales**.
2. **Registrar equipo** (nombre, por ejemplo `MacBook de Ana`).
3. Se abre una ventana con los comandos ya rellenados:
   - instalar `cloudflared` y este repo
   - `dockploy-agent configure` con `https://dockployback.gaolania.com.es` y tu token `dcp_...`
   - `dockploy-agent run`
4. **Copiar comando** y pegarlos en la terminal, en orden.
5. Deja `dockploy-agent run` abierto. Cuando el equipo esté **Online**, arranca tu app y pulsa **Publicar**.

El token `dcp_...` solo se muestra esa vez. No es el de Cloudflare. No lo envíes por chat.

## Si ya cerraste la ventana

Vuelve a registrar no se puede si ya tienes un agente. Si aún tienes el token:

```bash
dockploy-agent configure https://dockployback.gaolania.com.es dcp_TU_TOKEN
dockploy-agent run
```

Si no lo guardaste, revoca el equipo (sin túneles activos) y registra de nuevo: el panel vuelve a mostrar los comandos.

Config: `~/.dockploy-agent/config.json` (Windows: `%USERPROFILE%\.dockploy-agent\config.json`).

```bash
dockploy-agent status
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

- **Offline:** `dockploy-agent run` tiene que seguir.
- **No hay aplicación escuchando:** abre `http://127.0.0.1:PUERTO` en este PC.
- **Host / CORS:** permite el dominio público en tu app.
- Otro PC: cierra túneles, **Revocar equipo**, registra de nuevo y copia lo que muestre el panel.
