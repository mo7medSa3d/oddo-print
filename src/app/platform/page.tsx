import { redirect } from "next/navigation";

// /platform is the control-plane entry point: forward to the platform
// sign-in page, which itself forwards authenticated sessions to the
// dashboard after it resolves the platform session.
export default function PlatformIndexPage() {
  redirect("/platform/login");
}
