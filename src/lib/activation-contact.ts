/** Only a configured public contact number and opaque request reference leave Yaseir. */
export function activationWhatsAppUrl(reference: string): string | null {
  const configured = process.env.YASEIR_ACTIVATION_WHATSAPP?.trim() ?? "";
  const number = configured.replace(/^\+/, "");
  if (!/^[1-9]\d{7,14}$/.test(number) || !/^req_[A-Za-z0-9_-]{1,96}$/.test(reference)) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(`طلب تفعيل يسير / Yaseir activation: ${reference}`)}`;
}
