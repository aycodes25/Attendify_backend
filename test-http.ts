import * as fs from 'fs';
import FormData from 'form-data';

async function run() {
  try {
    const formData = new FormData();
    formData.append('image', fs.createReadStream('c:/Users/Hp/Documents/Attendify_frontend/public/next.svg'));
    formData.append('cameraName', 'Live Kiosk Web');

    const res = await fetch('http://localhost:3001/api/recognition/verify', {
      method: 'POST',
      body: formData as any,
      headers: formData.getHeaders()
    });
    const data = await res.json();
    console.log('Success:', data);
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}
run();
