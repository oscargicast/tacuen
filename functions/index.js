const functions = require("firebase-functions");
const fetch = require('node-fetch');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const telegramToken = process.env.TELEGRAM_TOKEN;


async function sendRequest(payload, telegramMethod = "sendMessage") {
  const url = `https://api.telegram.org/bot${telegramToken}/${telegramMethod}`;
  const response = await fetch(
      url,
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: {'Content-Type': 'application/json'}
      }
  );
  const jsonResponse = await response.json();
  return jsonResponse
}

function withoutProperty(obj, property) {
  const { [property]: unused, ...rest } = obj;
  return rest;
}

async function addMessageIdentifier(chatId, messageId, inlineMessageId, payload) {
  if (inlineMessageId) {
    payload.inline_message_id = inlineMessageId;
    payload = withoutProperty(payload, 'messageId');
    payload = withoutProperty(payload, 'chatId');
  } else if (chatId && messageId) {
    payload.chat_id = chatId;
    payload.message_id = messageId;
    payload = withoutProperty(payload, 'inlineMessageId');
  } else if (chatId) {
    payload.chat_id = chatId;
  }
  return payload;
}

async function sendMessage(chatId, message) {
  return {
    "chat_id": chatId,
    "text": message,
    "parse_mode": "MarkdownV2",
  };
}

async function createCallbackData(payload) {
  const db = getFirestore();
  const dataRef = db.collection('callbackData');
  const doc = await dataRef.add(payload);
  return doc.id;
}

async function getCallbackData(callbackId) {
  const db = getFirestore();
  const callbackRef = db.collection('callbackData').doc(callbackId);
  const callbackDoc = await callbackRef.get();
  if (!callbackDoc.exists) {
    return null;
  }
  return callbackDoc.data();
}

async function getBankList(chatId) {
  const db = getFirestore();
  const bankRef = db.collection('users').doc(chatId).collection('banks');
  const bankDocs = await bankRef.orderBy('name').get();
  if (bankDocs.empty) {
    return null;
  }
  const bankList = []
  bankDocs.forEach(doc => {
    const bankData = doc.data();
    bankList.push({
      id: doc.id,
      ...bankData
    })
  });
  return bankList;
}

async function getBankListPayload(chatId) {
  // Query db.
  const banks = await getBankList(chatId);
  const bankList = []
  let bankSubList = []
  let i = 1;
  for (const bank of banks) {
    let callbackData = {
      ...bank,
      banks: banks,
      method: "sendCurrencies",
      chatId: chatId,
    }
    let callbackId = await createCallbackData(callbackData)
    bankSubList.push({
      "text": bank.name,
      "callback_data": callbackId,
    })
    if (i % 2 === 0) {
      bankList.push(bankSubList)
      bankSubList = []
    }
    i++;
  }
  const payload = {
    "text": "Selecciona un banco",
    "parse_mode": "MarkdownV2",
    "reply_markup": {
      "inline_keyboard": bankList,
    },
  };
  return payload;
}

async function sendBanks(chatId) {
  const payload = await getBankListPayload(chatId)
  return payload;
}

async function editBankMessage(chatId) {
  const payload = await getBankListPayload(chatId)
  return payload;
}

async function sendCurrencies(chatId, messageId, inlineMessageId, bank) {
  const currencyList = []
  for (const account of bank.accounts) {
    let callbackData = {
      ...account,
      ...bank,
      method: "sendAccountTypes",
    };
    if (messageId) {
      callbackData.messageId = messageId;
    }
    if (inlineMessageId) {
      callbackData.inlineMessageId = inlineMessageId;
    }
    let callbackId = await createCallbackData(callbackData);
    currencyList.push({
      "text": account.currency,
      "callback_data": callbackId,
    })
  }
  const inlineKeyboard = [currencyList];

  // Add back button.
  const backButtonData = {
    chatId: chatId,
    method: "editBankMessage",
  }
  let backButtonDataId = await createCallbackData(
    await addMessageIdentifier(chatId, messageId, inlineMessageId, backButtonData)
  );
  inlineKeyboard.push([{
    "text": "⏪ Volver a bancos",
    "callback_data": backButtonDataId,
  }])
  // Send payload.
  const payload = {
    "text": `Selecciona la moneda de tu banco *${bank.name}*:`,
    "parse_mode": "MarkdownV2",
    "reply_markup": {
      "inline_keyboard": inlineKeyboard,
    },
  };
  return payload;
}

async function sendAccountTypes(chatId, messageId, inlineMessageId, account) {
  const accountTypes = []
  if (account.number) {
    accountTypes.push({
      type: 'number',
      text:  "Número de cuenta",
    });
  }
  if (account.cci) {
    accountTypes.push({
      type: 'cci',
      text:  "CCI",
    });
  }

  let callbackData;
  const accountTypesList = [];
  for (const accountType of accountTypes) {
    callbackData = {
      ...account,
      method: "sendAccount",
      accountType: accountType.type,
    }
    if (inlineMessageId) {
      callbackData.inlineMessageId = inlineMessageId;
    }
    let callbackId = await createCallbackData(callbackData)
    accountTypesList.push({
      "text": accountType.text,
      "callback_data": callbackId,
    })
  }

  const inlineKeyboard = [accountTypesList];
  // Add back button.
  const backButtonData = {
    ...account,
    method: "sendCurrencies",
  }
  let backButtonDataId = await createCallbackData(
    await addMessageIdentifier(chatId, messageId, inlineMessageId, backButtonData)
  );
  inlineKeyboard.push([{
    "text": "⏪ Volver a elegir moneda",
    "callback_data": backButtonDataId,
  }])

  const payload = {
    "text": `Selecciona el tipo de cuenta *${account.name}* *${account.currency}*:`,
    "parse_mode": "MarkdownV2",
    "reply_markup": {
      "inline_keyboard": inlineKeyboard,
    },
  };
  return payload;
}

async function sendAccount(account) {
  let accountTypeText;
  let accountNumber;
  if (account.accountType === 'number') {
    accountNumber = account.number;
    accountTypeText = 'cuenta';
  }
  if (account.accountType === 'cci') {
    accountNumber = account.cci;
    accountTypeText = 'CCI';
  }
  const payload = {
    "text": `Tu ${accountTypeText} *${account.name}* *${account.currency}* es: \`\`\`${accountNumber}\`\`\``,
    "parse_mode": "MarkdownV2",
  };
  return payload;
}

async function answerInlineQuery(chatId, inlineQueryId, inlineQuery, from) {
  const bankList = await getBankList(chatId);
  const results = []
  for (const bank of bankList) {
    const currencyList = []
    for (const account of bank.accounts) {
      let callbackData = {
        ...account,
        ...bank,
        method: "sendAccountTypes",
        chatId: chatId,
      }
      let callbackId = await createCallbackData(callbackData);
      currencyList.push({
        "text": account.currency,
        "callback_data": callbackId,
      })
    }
    results.push({
        "type": "article",
        "id": bank.id,
        "description": bank.description ? bank.description : "",
        "thumb_url": bank.description ? bank.thumb_url : "",
        "thumb_height": 1,
        "title": bank.name,
        "input_message_content": {
          "message_text": `Selecciona del banco *${bank.name}* de *${from.first_name}*:`,
          "parse_mode": "MarkdownV2",
        },
        "reply_markup": {
          "inline_keyboard": [currencyList],
        }
    })
  }
  const payload = {
    "inline_query_id": inlineQueryId,
    "cache_time": 0,
    "results": results,
  };
  return payload
  // return sendRequest(payload, 'answerInlineQuery');
}

exports.telegramWebhook = functions.https.onRequest(async (req, res) => {
  // Only POST methods are allowed.
  if (req.method !== 'POST') {
    return res.status(400).send('Only POST method is supported!');
  }
  // Validates secret.
  const telegramSecret = process.env.TELEGRAM_SECRET;
  if (req.get('X-Telegram-Bot-Api-Secret-Token') !== telegramSecret) {
    return res.status(401).send('The secret is not valid!');
  }
  // Inits request and set payload.
  const telegramUpdate = req.body;
  console.log('BODY', JSON.stringify(telegramUpdate, null, 2));
  const telegramCallback = telegramUpdate.callback_query;
  // {
  //   update_id: 16249630,
  //   callback_query: {
  //     id: '5472683401678560643',
  //     from: {
  //       id: 1274208398,
  //       is_bot: false,
  //       first_name: 'Oscar',
  //       last_name: 'Giraldo Castillo',
  //       username: 'oscargicast',
  //       language_code: 'en'
  //     },
  //     message: {
  //       message_id: 477,
  //       from: [Object],
  //       chat: [Object],
  //       date: 1659169295,
  //       text: 'Selecciona un banco',
  //       reply_markup: [Object]
  //     },
  //     chat_instance: '7650315382759812727',
  //     data: '["sendCurrencies","smxeA8Q0UnJLCxMO3Tyq"]'
  //   }
  // }
  const telegramMessage = telegramUpdate.message;
  // Inline mode:
  // {
  //   update_id: 16249571,
  //   inline_query: {
  //     id: '5472683401931538303',
  //     from: {
  //       id: 1274208398,
  //       is_bot: false,
  //       first_name: 'Oscar',
  //       last_name: 'Giraldo Castillo',
  //       username: 'oscargicast',
  //       language_code: 'en'
  //     },
  //     chat_type: 'private',
  //     query: '',
  //     offset: ''
  //   }
  // }
  // Inline callback:
  //  {
  //    update_id: 16249624,
  //    callback_query: {
  //      id: '5472683398449786184',
  //      from: {
  //        id: 1274208398,
  //        is_bot: false,
  //        first_name: 'Oscar',
  //        last_name: 'Giraldo Castillo',
  //        username: 'oscargicast',
  //        language_code: 'en'
  //      },
  //      inline_message_id: 'AQAAAPcZAACO4PJL2-r3NguYYqY',
  //      chat_instance: '4304899199284552832',
  //      data: '["sendAccountTypes","4XJGDGPzJyrkKtZDcBtV","Soles"]'
  //    }
  //  }
  const telegramInlineQuery= telegramUpdate.inline_query;
  let telegramMethod = "sendMessage";
  let payload;
  let telegramResponse;

  let chatId;
  let messageId;
  let inlineMessageId;

  // Input: Texts.
  if (telegramMessage) {
    chatId = telegramMessage.chat.id.toString();
    const message = telegramMessage.text;
    switch (message) {
      case '/listar_cuentas' || '/start':
        payload = await sendBanks(chatId);
        break;
      case '/chat_id':
        payload = sendMessage(chatId, `Mi chat id es: \`\`\`${chatId}\`\`\``)
        break;
      default:
        payload = sendMessage(chatId, message);
    }
  }
  // Input: Callbacks.
  if (telegramCallback) {
    const callbackId = telegramCallback.data
    const callbackData = await getCallbackData(callbackId);
    if (!callbackData) {
      return res.send('There is not callback data!');
    }
    console.log('callbackData', callbackData)
    // References to the message in inline mode.
    inlineMessageId = telegramCallback.inline_message_id;
    console.log('inlineMessageId', inlineMessageId);
    // Refeference to the user's chat and message.
    chatId = callbackData.chatId;
    messageId = callbackData.message_id;
    if (!inlineMessageId && !messageId) {
      messageId = telegramCallback.message.message_id;
    }
    // Execute callback from callbackMethod.
    telegramMethod = "editMessageText"
    switch (callbackData.method) {
      case 'editBankMessage':
        payload = await editBankMessage(chatId);
        break;
      case 'sendCurrencies':
        payload = await sendCurrencies(chatId, messageId, inlineMessageId, callbackData);
        break;
      case 'sendAccountTypes':
        payload = await sendAccountTypes(chatId, messageId, inlineMessageId, callbackData);
        break;
      case 'sendAccount':
        payload = await sendAccount(callbackData);
        break;
      default:
        payload = 'Callback not found';
    }
  }
  // Input: Inline mode.
  if (telegramInlineQuery) {
    const from = telegramInlineQuery.from;
    chatId = from.id.toString();
    const inlineQueryId = telegramInlineQuery.id;
    const inlineQuery = telegramInlineQuery.query;
    payload = answerInlineQuery(chatId, inlineQueryId, inlineQuery, from);
    telegramMethod = "answerInlineQuery"
  }
  // Add message identifier to the payload.
  console.log('MESSAGE IDENTIFIER', JSON.stringify({chatId, messageId, inlineMessageId}, null, 2));
  payload = await addMessageIdentifier(chatId, messageId, inlineMessageId, payload);
  console.log('PAYLOAD TO SEND', JSON.stringify(payload, null, 2));
  // Bot reply.
  telegramResponse = await sendRequest(payload, telegramMethod);
  console.log('RESPONSE: ', JSON.stringify(telegramResponse, null, 2));
  // Response to Telegram in order to not send more callbacks to webhook.
  return res.send(telegramResponse);
});


exports.populate = functions.https.onRequest(async (req, res) => {
  // Only POST methods are allowed.
  if (req.method !== 'POST') {
    return res.status(400).send('Only POST method is supported!');
  }
  const body = req.body;
  // Set vars.
  const chatId = body.chat_id.toString()
  const banks = body.banks;
  const db = getFirestore();

  // Delete banks.
  const bankRef = db.collection('users').doc(chatId).collection('banks');
  const bankDocs = await bankRef.get();
  if (!bankDocs.empty) {
    bankDocs.forEach(doc => {
      doc.ref.delete();
    });
  }

  // Create banks.
  const usersRef = db.collection('users');
  for (const bank of banks) {
    await usersRef.doc(chatId).set({
      chatId: chatId,
    });
    await usersRef.doc(chatId).collection('banks').doc().set(bank);
  }
  return res.send("ok");
});