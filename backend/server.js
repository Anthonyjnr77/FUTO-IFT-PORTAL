const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

import('./supabase/functions/api/server-core.js')
  .then(({ startServer }) => startServer())
  .catch(error => {
  console.error('FUTO IFT API could not start:', error.message);
  process.exitCode = 1;
});
