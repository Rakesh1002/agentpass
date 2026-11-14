import Hero from "@/components/Hero";
import Features from "@/components/Features";
import Agents from "@/components/Agents";
import Waitlist from "@/components/Waitlist";
import Footer from "@/components/Footer";

export default function HomePage() {
  return (
    <main className="min-h-screen">
      <Hero />
      <Features />
      <Agents />
      <Waitlist />
      <Footer />
    </main>
  );
}
