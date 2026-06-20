import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

// Ensure global WebSocket is available for Node 20
if (!global.WebSocket) {
  global.WebSocket = require('ws');
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function testInsert() {
  const insertPayload = {
    captured_face_url: 'http://test.com/face.jpg',
    snapshot_url: 'http://test.com/snap.jpg',
    detection_date: new Date().toISOString().split('T')[0],
    detection_time: new Date().toTimeString().split(' ')[0],
    status: 'Pending'
  };
  const { data, error } = await supabase.from('visitors').insert(insertPayload).select().single();
  console.log('Result:', data, error);
}

testInsert();
