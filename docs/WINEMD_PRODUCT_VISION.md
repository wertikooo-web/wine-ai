# WineMD Product Vision

## Product idea

WineMD is a family of conversational wine products built around a digital
sommelier. The user should not merely hear an answer: when the subject benefits
from visual support, WineMD should synchronise speech with a clear visual story.

The experience must feel like a knowledgeable expert is present, understands
the current conversation, and shows only the information that is relevant at
that moment.

## 1. Live wine visualisation

During a conversation, the interface may show:

- bottle and label;
- producer and winery;
- region and origin;
- grape composition;
- serving temperature;
- food pairings;
- awards;
- aroma notes.

Aroma notes should be represented by small, recognisable visual elements, for
example cherry, strawberry, apricot, flowers, herbs, spices, chocolate, coffee,
oak, and citrus. They should appear in synchronisation with the sommelier's
story so that the user hears, sees, and remembers the information.

### Visual activation principle

The visual layer is governed by conversational meaning, not by microphone
state.

- General conversation keeps the sommelier/avatar view.
- A verified reference to a specific wine opens that wine's visual card.
- A recommendation may open a card only after the recommendation engine has
  resolved a real, published wine.
- Follow-up questions may keep the current wine visible while its context
  remains active.
- Changing the subject clears the wine-specific visual.
- Commerce is shown only when there is a valid, active offer.

Assistant prose alone must never invent or select a wine card. Visuals must be
resolved from structured, verified data.

## 2. Multiple AI engines and voices

WineMD supports multiple AI engines, initially:

- Gemini;
- Grok.

The administration interface must allow an authorised operator to:

- select the active model without changing code;
- switch models quickly;
- compare answer quality;
- compare latency;
- compare operating cost;
- test and select available voices.

Model choice and voice choice are configuration concerns. They must not alter
the WineMD knowledge model, published wine data, or the visual protocol.

## 3. WineMD ecosystem

All products share one knowledge, conversation, personalisation, and visual
storytelling platform while adapting the presentation to the screen and usage
context.

### Winery website widget

An embeddable conversational sommelier for winery websites. Visitors can ask
about wines, winery history, tours, visits, and purchasing.

### Interactive vertical display

A full-screen digital consultant for wineries, museums, airports, exhibitions,
shops, and tourist centres. It combines voice conversation with large-format
visual storytelling.

### Tabletop digital sommelier

A compact product for restaurants, tasting rooms, hotels, home collections, and
dinners. It creates the sense of a personal sommelier being present.

### Premium collectible device

An exclusive personal device for diplomats, investors, partners, honoured
guests, competition winners, and collectors. With the owner's permission it
builds long-term personal memory around:

- favourite wines;
- conversation history;
- personal collection;
- past tastings;
- recommendations and preferences.

## 4. Shared platform principles

1. One canonical knowledge system supplies every WineMD product.
2. Only verified and published facts may drive product visuals.
3. Wine facts, media rights, commerce offers, and personal memory are separate
   data domains.
4. The same Wine Card contract is reused across website, vertical display,
   tabletop device, and premium device.
5. Visual storytelling is event-driven and independent of a particular AI
   model.
6. Personal memory requires explicit user identity, consent, and isolation.
7. New channels and devices should reuse the platform rather than fork its
   knowledge or business logic.

## Near-term vertical milestone

Prove the complete product loop with one real, published Aurelius wine:

1. ingest and verify official winery information;
2. review and publish the wine in KOS;
3. attach approved bottle, label, and aroma media;
4. expose the published Wine Card through a stable API;
5. resolve the wine from a real conversation;
6. open, update, retain, and clear the visual at the correct moments;
7. show commerce only when a valid offer exists;
8. verify the same result with Gemini and Grok.

Only after this vertical scenario works reliably should WineMD add bulk wine
import, a full catalogue dashboard, and additional product surfaces.
