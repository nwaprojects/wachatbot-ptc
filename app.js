const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');

const app = express();
app.use(express.json());

// ---------------------------------------------------------
// 1. CONFIGURATION (سیٹنگز)
// ---------------------------------------------------------
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY || ""; 
const GOOGLE_PRIVATE_KEY = privateKeyRaw.replace(/\\n/g, '\n');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ---------------------------------------------------------
// 2. MEMORY (عارضی میموری)
// ---------------------------------------------------------
const userState = {}; 
const nameCacheStore = {}; 

// ---------------------------------------------------------
// 3. GOOGLE SHEET FUNCTION (ڈیٹا سیونگ logic)
// ---------------------------------------------------------
async function appendToSheet(data) {
  console.log("📝 Attempting to save to Google Sheet...");
  try {
    const serviceAccountAuth = new JWT({
      email: GOOGLE_CLIENT_EMAIL,
      key: GOOGLE_PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    await sheet.addRow({
      "Time": data.date,
      "Name": data.customerName,
      "Phone": data.phone,
      // 4th option will show up with only Name, Phone, Category, and Complaint Message
      "Complaint Type": data.category,
      "Salesman Name": data.salesman,
      "Shop Name": data.shop,
      "Address": data.address,
      "Complaint Message": data.complaint 
    });

    console.log('✅ Data SAVED successfully!');
  } catch (error) {
    console.error('❌ Error saving to sheet:', error.message);
  }
}

// ---------------------------------------------------------
// 4. WHATSAPP SEND FUNCTION
// ---------------------------------------------------------
async function sendReply(to, bodyText) {
  console.log(`📤 Sending message to ${to}: ${bodyText.substring(0, 20)}...`);
  try {
    await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      data: {
        messaging_product: 'whatsapp',
        to: to,
        text: { body: bodyText },
      },
    });
    console.log("✅ Message sent successfully!");
  } catch (error) {
    console.error('❌ Error sending message:', error.response ? JSON.stringify(error.response.data) : error.message);
  }
}

// ---------------------------------------------------------
// 5. WEBHOOK LOGIC
// ---------------------------------------------------------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
    console.log("✅ Webhook Verified Successfully!");
    res.send(req.query['hub.challenge']);
  } else {
    console.error("❌ Webhook Verification Failed. Token mismatch.");
    res.sendStatus(400);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log("📨 Incoming Webhook:", JSON.stringify(body, null, 2));

    if (body.object) {
        if (
            body.entry &&
            body.entry[0].changes &&
            body.entry[0].changes[0].value.messages &&
            body.entry[0].changes[0].value.messages[0]
        ) {
          const message = body.entry[0].changes[0].value.messages[0];
          const senderPhone = message.from;
          
          const nameFromPayload = message.contacts ? message.contacts[0].profile.name : null;

          if (message.type !== 'text') {
            console.log("⚠️ Received non-text message. Ignoring.");
            return;
          }
          
          const textMessage = message.text.body.trim();
          const lowerText = textMessage.toLowerCase();

          if (!userState[senderPhone]) {
              userState[senderPhone] = { step: 'START', data: {} };
          }
          
          const currentUser = userState[senderPhone];
          
          // 2. Name Cache Logic
          let senderName = "Unknown";
          
          if (nameFromPayload) {
              senderName = nameFromPayload;
              nameCacheStore[senderPhone] = nameFromPayload;
          } else if (nameCacheStore[senderPhone]) {
              senderName = nameCacheStore[senderPhone];
          }
          
          console.log(`👤 User: ${senderName} (${senderPhone}) says: "${textMessage}"`);

          // ---------------- LOGIC ----------------

          // 1. Greeting / Reset (Only resets if the message is *EXACTLY* a greeting word)
          const isStrictGreeting = lowerText === 'salam' || lowerText === 'hi' || lowerText === 'hello' || lowerText === 'hy' || lowerText === 'reset'; 
          
          if (isStrictGreeting) {
              console.log("🚀 Detected Greeting/Reset. Sending Menu...");
              
              userState[senderPhone].step = 'START';
              userState[senderPhone].data = {}; 
              
              const menuText = `خوش آمدید! 🌹
ہماری کسٹمر سپورٹ سروس میں آپ کا استقبال ہے۔

براہِ کرم مطلوبہ آپشن کا اندراج کریں:

1️⃣. سیل مین سے متعلق شکایت
2️⃣. ڈسٹری بیوٹر سے متعلق شکایت
3️⃣. سٹاک کی کوالٹی/ قیمت یا بل کے متعلق شکایت
4️⃣. سٹاک آرڈر`;

              await sendReply(senderPhone, menuText);
          }
          
          // 2. Menu Selection (1-4)
          else if (currentUser.step === 'START') {
              
              if (['1', '2', '3', '4'].includes(textMessage)) {
                  let category = '';
                  
                  if (textMessage === '1') category = 'Salesman Complaint';
                  if (textMessage === '2') category = 'Distributor Complaint';
                  if (textMessage === '3') category = 'Quality/Price/Bill';
                  if (textMessage === '4') category = 'Stock Order';

                  currentUser.data.category = category;
                  
                  currentUser.step = 'ASK_NAME'; 
                  
                  await sendReply(senderPhone, "شکریہ۔ براہ کرم اپنا پورا نام لکھیں۔");
                  
              } else {
                  await sendReply(senderPhone, "براہ کرم مینو میں سے درست نمبر (1, 2, 3 یا 4) کا انتحاب کریں۔");
              }
          }
          
          // 2.5 ASK_NAME Step - NEW LOGIC for Option 4
          else if (currentUser.step === 'ASK_NAME') {
              currentUser.data.customerName = textMessage;
              
              if (currentUser.data.category === 'Stock Order') {
                  currentUser.step = 'ASK_PRODUCT_TYPE'; // Go to new sub-menu
                  const productMenu = `
براہِ کرم مطلوبہ آپشن کا اندراج کریں:

1️⃣. سگریٹ آرڈر کیلئے
2️⃣. ویلو آرڈر کیلئے
                  `;
                  await sendReply(senderPhone, productMenu.trim());
              } else {
                  // Existing Complaint Flow
                  currentUser.step = 'ASK_SALESMAN';
                  await sendReply(senderPhone, "شکریہ! اب براہ کرم سیلز مین کا نام لکھیں۔"); 
              }
          }
          
          // 3. ASK_PRODUCT_TYPE Step (NEW)
          else if (currentUser.step === 'ASK_PRODUCT_TYPE') {
              let orderMenu = "";
              let productType = "";
              
              if (textMessage === '1') {
                  productType = 'Cigarette';
                  orderMenu = `
*براہِ کرم سگریٹ کا آرڈر آؤٹر/پیکٹ میں کیجئے*
1	Dunhill Lights 20HL
2	Dunhill Switch 20HL
3	Benson & Hedges 20HL - New
4	Gold Leaf Classic 20HL
5	Dunhill Special 20HL
6	Capstan by Pall Mall 20HL
7	Capstan Filter 20HL
8	John Player 20HL
9	Gold Flake by Rothmans 20HL
10	Embassy Filter 20HL
11	Capstan International 20HL
                  `.trim();
              } else if (textMessage === '2') {
                  productType = 'VELO';
                  orderMenu = `
*براہِ کرم ویلو کا آرڈر بلِسٹر/کین میں کیجئے*
1	 VELO Berry Frost 6MG - Nano 
2	 VELO Berry Frost 10MG 
3	 VELO Berry Frost 14MG 
4	 VELO Polar Mint 6MG - Nano 
5	 VELO Polar Mint 10MG 
6	 VELO Polar Mint 14MG 
7	 VELO Rich Elaichi 6MG - Nano 
8	 VELO Rich Elaichi 10MG 
9	 VELO Strawberry Ice 10MG 
10	 VELO Frosty Lemon 10MG 
11	 VELO Wintery Watermelon 10MG 
12	 VELO Tropical Ice 10MG 
13	 VELO Mango Flame 14MG 
14	 VELO Groovy Grape 6MG - Nano 
15	 VELO Groovy Grape 10MG 
                  `.trim();
              }
              
              if (orderMenu) {
                  currentUser.data.productType = productType;
                  currentUser.step = 'ASK_ORDER_INPUT'; // Next step for final order detail
                  await sendReply(senderPhone, orderMenu);
                  await sendReply(senderPhone, "شکریہ! اب براہ کرم **آئٹم نمبر اور مقدار** کے ساتھ اپنا آرڈر لکھیں۔");
              } else {
                  await sendReply(senderPhone, "براہ کرم سگریٹ کے لیے '1' اور ویلو کے لیے '2' کا اندراج کریں۔");
              }
          }


          // 3. Complaint Flow Step: Ask Salesman (Only for Complaints)
          else if (currentUser.step === 'ASK_SALESMAN') {
              currentUser.data.salesman = textMessage;
              currentUser.step = 'ASK_SHOP';
              await sendReply(senderPhone, "شکریہ! اب اپنی دکان کا نام لکھیں۔");
          }

          // 4. Complaint Flow Step: Ask Shop (Only for Complaints)
          else if (currentUser.step === 'ASK_SHOP') {
              currentUser.data.shop = textMessage;
              currentUser.step = 'ASK_ADDRESS';
              await sendReply(senderPhone, "شکریہ۔ اب دکان کا ایڈریس لکھیں۔");
          }

          // 5. Complaint Flow Step: Ask Address (Only for Complaints)
          else if (currentUser.step === 'ASK_ADDRESS') {
              currentUser.data.address = textMessage;
              currentUser.step = 'ASK_COMPLAINT';
              await sendReply(senderPhone, "شکریہ۔ آخر میں اپنی شکایت تفصیل سے لکھیں۔");
          }

          // 6. Final Step: ASK_COMPLAINT or ASK_ORDER_INPUT
          else if (currentUser.step === 'ASK_COMPLAINT' || currentUser.step === 'ASK_ORDER_INPUT') {
              currentUser.data.complaint = textMessage;
              
              const category = currentUser.data.category;
              const isOrder = category === 'Stock Order';
              let contactInfo = "";
              let finalConfirmation = "";

              // رابطہ نمبر کی شرط
              if (category === 'Distributor Complaint') {
                  contactInfo = `
*ڈسٹری بیوٹر ڈائریکٹر: محمد اعجاز شیخ*
0333-8033113`;
              } else {
                  contactInfo = `
*ڈسٹری بیوٹر مینیجر: شیخ محمد مسعود*
0300-7753113`;
              }

              if (isOrder) {
                  // Order Specific Message
                  finalConfirmation = `
*آپ کا سٹاک آرڈر سسٹم میں درج کر لیا گیا ہے*
----------------------------------------
نام: ${currentUser.data.customerName}
آرڈر کی قسم: ${currentUser.data.productType || 'N/A'}
آرڈر کی تفصیل: ${currentUser.data.complaint}
بہت جلد آپ سے رابطہ کر لیا جائے گا۔ شکریہ! 🌹
${contactInfo}
                  `.trim();
              } else {
                  // Complaint Specific Message
                  finalConfirmation = `
*آپ کا ڈیٹا سسٹم میں درج کر لیا گیا ہے*
----------------------------------------
سیل مین کا نام: ${currentUser.data.salesman || 'N/A'}
دکان کا نام: ${currentUser.data.shop || 'N/A'}
دکان کا ایڈریس: ${currentUser.data.address || 'N/A'}
شکایت کی قسم: ${category}
شکایت کی تفصیل: ${currentUser.data.complaint}
بہت جلد آپ سے رابطہ کر لیا جائے گا۔ شکریہ! 🌹
${contactInfo}
                  `.trim();
              }

              const finalData = {
                  date: new Date().toLocaleString(),
                  category: category || 'N/A (Flow Break)', 
                  customerName: currentUser.data.customerName || senderName,
                  phone: senderPhone,
                  // Only include if available (will be empty for orders)
                  salesman: currentUser.data.salesman || '', 
                  shop: currentUser.data.shop || '', 
                  address: currentUser.data.address || '', 
                  complaint: currentUser.data.complaint
              };

              await sendReply(senderPhone, finalConfirmation);
              
              await appendToSheet(finalData);
              delete userState[senderPhone];
          }

        }
    }
  } catch (e) {
    console.error('❌ SYSTEM ERROR:', e);
  }
});

// ---------------------------------------------------------
// 6. START SERVER
// ---------------------------------------------------------
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
