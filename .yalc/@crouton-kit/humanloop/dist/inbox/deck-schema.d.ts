import { z } from 'zod';
import type { Deck } from '../types.js';
export declare const interactionOptionSchema: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    shortcut: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const preAnswerSchema: z.ZodObject<{
    selectedOptionId: z.ZodOptional<z.ZodString>;
    selectedOptionIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    freetext: z.ZodOptional<z.ZodString>;
    label: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const deckSchema: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodObject<{
        sessionName: z.ZodOptional<z.ZodString>;
        askedBy: z.ZodOptional<z.ZodString>;
        blockedSince: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    interactions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        subtitle: z.ZodOptional<z.ZodString>;
        body: z.ZodOptional<z.ZodString>;
        bodyPath: z.ZodOptional<z.ZodString>;
        options: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            label: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            shortcut: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        multiSelect: z.ZodOptional<z.ZodBoolean>;
        allowFreetext: z.ZodOptional<z.ZodBoolean>;
        freetextLabel: z.ZodOptional<z.ZodString>;
        kind: z.ZodOptional<z.ZodEnum<{
            notify: "notify";
            validation: "validation";
            decision: "decision";
            context: "context";
            error: "error";
        }>>;
        preAnswered: z.ZodOptional<z.ZodObject<{
            selectedOptionId: z.ZodOptional<z.ZodString>;
            selectedOptionIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
            freetext: z.ZodOptional<z.ZodString>;
            label: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare function inlineBodyPath(deckPath: string, bodyPath: string): string;
export declare function parseDeck(deckPath: string): Deck;
export declare function validateDeck(parsed: unknown): Deck;
