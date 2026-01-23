import Demo from "@/components/landing/Demo";
import Features from "@/components/landing/Features";
import Footer from "@/components/landing/Footer";
import Header from "@/components/landing/Header";
import Hero from "@/components/landing/Hero";
import HowItWorks from "@/components/landing/HowItWorks";
import Installation from "@/components/landing/Installation";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main>
        <Hero />
        <Features />
        <Demo />
        <HowItWorks />
        <Installation />
      </main>
      <Footer />
    </div>
  );
};

export default Index;
