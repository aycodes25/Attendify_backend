import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();
if (!global.WebSocket) global.WebSocket = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkRows() {
  const { data, error } = await supabase.from('visitors').select('*');
  console.log('Total visitors:', data?.length);
  if (error) console.error(error);
}
checkRows();
