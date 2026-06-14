# Create Twilio Number: "Ownly Front Desk demo 2"

## Option 1: Via Web Console (Your Link)

You're already logged in at: https://console.twilio.com/us1/develop/phone-numbers/manage/incoming

### Steps:

1. **Click "Buy a Number"** (in Manage section)
2. **Choose Toll-Free** (855 area code)
3. **Search** for available numbers
4. **Select one** and click "Buy"
5. **In Setup, set:**
   - **Friendly Name:** `Ownly Front Desk demo 2`
   - **Voice:** Configure webhook later
   - **SMS:** Configure webhook later
6. **Click "Confirm Purchase"**

Done! You'll see your number in the list.

---

## Option 2: Via CLI (Faster)

```bash
# Install Twilio CLI if not already installed
npm install -g twilio-cli

# Authenticate (opens browser)
twilio login

# Create the number
twilio phone-numbers:buy:local \
  --country-code US \
  --area-code 855 \
  --friendly-name "Ownly Front Desk demo 2"
```

You'll see output:
```
SID: PN123456789
Phone Number: +1 855-XXX-XXXX
Friendly Name: Ownly Front Desk demo 2
```

---

## Option 3: Programmatically

```javascript
const twilio = require('twilio');
const client = twilio(accountSid, authToken);

client.incomingPhoneNumbers.create({
  areaCode: '855',
  friendlyName: 'Ownly Front Desk demo 2',
  voiceUrl: 'https://your-supabase-project.supabase.co/functions/v1/api',
  smsUrl: 'https://your-supabase-project.supabase.co/functions/v1/api',
})
.then(number => console.log('Created:', number.phoneNumber))
.catch(err => console.error(err));
```

---

## After Creating the Number

You'll have:
- ✅ **Phone Number** (e.g., +1 855-XXX-XXXX)
- ✅ **Account SID** (from account dashboard)
- ✅ **Auth Token** (from account dashboard)

Save these for `DEPLOYMENT_GUIDE.md` Phase 2.

---

## Quick Check

Go to **Phone Numbers → Active Numbers** and verify:
- ✅ Name shows "Ownly Front Desk demo 2"
- ✅ Status is "Active"
- ✅ Number is displayed (e.g., +1 855-XXX-XXXX)

You're good to go! 🚀
