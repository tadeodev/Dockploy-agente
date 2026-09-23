const { chmodSync } = require('node:fs')

chmodSync('dist/index.js', 0o755)
