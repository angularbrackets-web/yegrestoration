export type ReplyTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
};

export const REPLY_TEMPLATES: ReplyTemplate[] = [
  {
    id: 'received',
    name: 'Quote Request Received',
    subject: 'Your {{service}} Quote Request — YEG Restoration',
    body: `Hi {{name}},

Thank you for reaching out to YEG Restoration. We've received your request for {{service}} and our team is reviewing the details now.

We'll follow up within 2 hours. If this is an active emergency, please call us directly at (780) 244-4747 — we're available 24/7.

Best regards,
YEG Restoration Team`,
  },
  {
    id: 'emergency',
    name: 'Emergency Team Dispatched',
    subject: 'Emergency Response Team On The Way — YEG Restoration',
    body: `Hi {{name}},

We've dispatched an emergency response team to your location. They will arrive within [ETA].

Please ensure someone is available to provide access to the affected area. Our technicians will bring all required equipment.

If you need to reach us urgently, call (780) 244-4747.

Stay safe,
YEG Restoration Team`,
  },
  {
    id: 'appointment',
    name: 'Appointment Confirmed',
    subject: 'Your Appointment is Confirmed — YEG Restoration',
    body: `Hi {{name}},

Your appointment with YEG Restoration has been confirmed:

  Service:   {{service}}
  Date:      [DATE]
  Time:      [TIME]
  Location:  [ADDRESS]

Please ensure the affected area is accessible when we arrive. Our technician will bring all necessary equipment and materials.

Need to reschedule? Reply to this email or call (780) 244-4747.

See you soon,
YEG Restoration Team`,
  },
  {
    id: 'quote',
    name: 'Quote Ready',
    subject: 'Your Restoration Estimate — YEG Restoration',
    body: `Hi {{name}},

Thank you for your patience while we assessed your {{service}} needs. Here is our estimate:

  Scope of Work:   [DESCRIPTION]
  Estimated Cost:  $[AMOUNT]
  Estimated Time:  [TIMELINE]

This quote is valid for 30 days. To approve and schedule, reply to this email or call us at (780) 244-4747.

Best regards,
YEG Restoration Team`,
  },
  {
    id: 'followup',
    name: 'Post-Service Follow-Up',
    subject: 'How Did We Do? — YEG Restoration',
    body: `Hi {{name}},

We hope your {{service}} has been completed to your full satisfaction. We wanted to check in and make sure everything looks great.

If you have any concerns or questions, don't hesitate to reach out — we stand behind our work.

We'd really appreciate it if you could take a moment to leave us a review:
  Google: [REVIEW LINK]

Thank you for choosing YEG Restoration. We're here whenever you need us.

Warm regards,
YEG Restoration Team`,
  },
];
