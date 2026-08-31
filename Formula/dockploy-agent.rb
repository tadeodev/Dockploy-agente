# typed: false
# frozen_string_literal: true

class DockployAgent < Formula
  desc "Local connector for Dockploy remote tunnels"
  homepage "https://github.com/tadeodev/Dockploy-agente"
  url "https://github.com/tadeodev/Dockploy-agente/archive/e829a91cfe79e40db4d2746202689e0a35c5ecf5.tar.gz"
  version "0.3.0"
  sha256 "a1eca2cdcc2c87cf8a2fbffa828d9d38176e3d28849b5c1e17d341cad84a3928"
  license "Apache-2.0"

  head "https://github.com/tadeodev/Dockploy-agente.git", branch: "main"

  depends_on "cloudflared"
  depends_on "node"

  def install
    system "npm", "ci"
    system "npm", "run", "build"

    libexec.install "dist/index.js"
    (bin/"dockploy-agent").write <<~SH
      #!/bin/bash
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/index.js" "$@"
    SH
  end

  def caveats
    <<~EOS
      Configura el agente y arráncalo:
        dockploy-agent login <URL_DOCKPLOY> <EMAIL> <CONTRASEÑA>
        dockploy-agent start

      Para que arranque al iniciar sesión (usa `run`, no combines con `start`):
        brew services start dockploy-agent
    EOS
  end

  service do
    run [opt_bin/"dockploy-agent", "run"]
    keep_alive true
    working_dir var
    log_path var/"log/dockploy-agent.log"
    error_log_path var/"log/dockploy-agent.log"
  end

  test do
    assert_match "Dockploy Agent", shell_output("#{bin}/dockploy-agent")
  end
end
