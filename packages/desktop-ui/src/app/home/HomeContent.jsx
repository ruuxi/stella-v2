import { useEffect, useState } from "react";
import "./home.css";
function getTimeBasedGreeting(date) {
    const hour = date.getHours();
    if (hour < 5)
        return "Good night";
    if (hour < 12)
        return "Good morning";
    if (hour < 17)
        return "Good afternoon";
    if (hour < 21)
        return "Good evening";
    return "Good night";
}
const FUN_GREETINGS = [
    "Welcome back!",
    "Hey there!",
    "Glad you're here",
    "Ready when you are",
    "Let's make today great",
    "What's on your mind?",
    "Where should we start?",
    "Let's dive in",
    "Good to see you",
    "Hey, I'm all ears",
    "Let's create something",
    "Ready to roll?",
    "What are we tackling?",
    "Hello, friend",
    "Howdy!",
    "Welcome aboard",
    "Let's go!",
    "What's up?",
    "Let's make magic",
    "Pick a quest",
    "Adventure awaits",
    "Let's build something cool",
    "Good to have you back",
    "Let's do this",
    "Onward!",
    "What can we explore today?",
    "Hello, hello",
    "Greetings, traveler",
    "Let's chase some ideas",
    "Where to next?",
    "Hey, friend",
    "Ready to make a dent?",
    "Let's cook something up",
    "What's the mission?",
    "Hi! What's first?",
    "Let's get curious",
    "Bring me your best ideas",
    "Tell me everything",
    "What's the plan?",
    "Let's make something",
];
// Probability the greeting is a random fun message instead of the time-of-day greeting.
const FUN_GREETING_CHANCE = 0.25;
function pickInitialGreetingState() {
    if (Math.random() < FUN_GREETING_CHANCE) {
        const idx = Math.floor(Math.random() * FUN_GREETINGS.length);
        return { kind: "fun", text: FUN_GREETINGS[idx] };
    }
    return { kind: "time" };
}
function useGreeting() {
    const [state] = useState(pickInitialGreetingState);
    const [, forceTick] = useState(0);
    useEffect(() => {
        if (state.kind !== "time")
            return;
        // Re-evaluate every minute so the time-of-day greeting stays accurate across boundaries.
        const interval = setInterval(() => forceTick((n) => n + 1), 60_000);
        return () => clearInterval(interval);
    }, [state.kind]);
    if (state.kind === "fun")
        return state.text;
    return getTimeBasedGreeting(new Date());
}
export function HomeContent({ children }) {
    const greeting = useGreeting();
    return (<div className="home-content">
      <h1 className="home-stella-title">{greeting}</h1>

      {children}
    </div>);
}
