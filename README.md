# Dockploy Agent

Agente local para [Dockploy](https://github.com/tadeodev/Dockploy). Publica una aplicación que corre en tu ordenador: Dockploy crea un named tunnel de Cloudflare y este proceso ejecuta `cloudflared` junto a tu app.

No abre puertos en el router. La app puede escuchar solo en `127.0.0.1`.

Cada cuenta de Dockploy admite **un agente activo**. Para cambiar de ordenador, cierra los túneles y revoca el equipo en el panel.

## Requisitos

- Node.js 20 o superior
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) en el `PATH`
- URL HTTPS de tu API Dockploy (en local, HTTP solo si es `localhost`)
- Token de equipo `dcp_...` generado en Dockploy → **Túneles locales** → Registrar equipo (se muestra una sola vez)

El administrador de Dockploy debe tener Cloudflare named tunnels configurado en **Configuración** (token, Account ID, Zone ID y dominio). Eso vive en el servidor, no en este repo.

## Instalar

```bash
git clone https://github.com/tadeodev/Dockploy-agente.git
cd Dockploy-agente
npm install
npm run build
npm link
```

En Linux puede hacer falta `sudo npm link`.

Instala también `cloudflared`:

```bash
# macOS
brew install cloudflared

# Windows
winget install --id Cloudflare.cloudflared
```

En Ubuntu/Debian sigue la [instalación oficial de Cloudflare](https://pkg.cloudflare.com/index.html).

Comprueba:

```bash
cloudflared --version
dockploy-agent
```

## Usar

1. En Dockploy, registra el equipo y copia el token.
2. En este ordenador:

```bash
dockploy-agent configure https://TU_API_DOCKPLOY dcp_TOKEN_GENERADO
dockploy-agent run
```

La configuración se guarda con permisos restringidos:

- macOS/Linux: `~/.dockploy-agent/config.json`
- Windows: `%USERPROFILE%\.dockploy-agent\config.json`

Cuando el agente hace heartbeat, el equipo aparece **Online**.

3. Arranca tu aplicación (`npm run dev`, etc.) y comprueba `http://127.0.0.1:PUERTO`.
4. En Dockploy: equipo online, nombre de la app, puerto → **Publicar**.

El servidor crea el túnel; el agente recibe la orden en el siguiente heartbeat. El estado pasa por Pendiente, Conectando y Activo.

```bash
dockploy-agent status
```

## Mantenerlo en marcha

En producción no lo dejes en una terminal temporal. Ejemplo con systemd (`/etc/systemd/system/dockploy-agent.service`):

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
sudo journalctl -u dockploy-agent -f
```

En macOS puedes usar `launchd`; en Windows, el Programador de tareas.

## Cerrar y revocar

En el panel, **Cerrar túnel** para el DNS y `cloudflared`. Para retirar el ordenador, cierra los túneles y **Revocar equipo**: el token `dcp_...` dejará de valer.

## Problemas frecuentes

**Offline:** `dockploy-agent run` debe seguir activo; la URL es la del **backend**, no la del frontend; usa HTTPS; prueba `dockploy-agent status`.

**No hay ninguna aplicación escuchando:** abre `http://127.0.0.1:PUERTO` en la misma máquina.

**Host / CORS en la URL pública:** el túnel está bien; añade el dominio a `allowedHosts`, CORS o el equivalente de tu framework.

**Seguridad:** no envíes el token por chat. Revoca equipos perdidos. Una URL pública no autentica por sí sola.

## Comandos

```
dockploy-agent configure <URL_DOCKPLOY> <TOKEN_EQUIPO>
dockploy-agent run
dockploy-agent status
```
