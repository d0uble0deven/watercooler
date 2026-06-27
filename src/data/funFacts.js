'use strict';

// Master list of conversation-starter fun facts for calendar invite emails.
//
// This file is the SOURCE/CONTENT only — a flat list of vetted, SFW, one-or-two
// sentence facts. Every entry has been fact-checked to avoid common myths.
//
// USAGE STATE (which have been used vs. queued) is NOT stored here — it lives
// in the database (fun_facts table), because it changes at runtime and a
// version-controlled file shouldn't be rewritten by the running app. On startup
// the app seeds any new facts from this list into the table; selection draws the
// oldest-unused fact per match, recycling oldest-used-first once the pool is
// exhausted (and warns an admin when that happens).
//
// To add more: append strings to the array below and restart — the seeder picks
// up anything not already in the table. Keep them accurate, light, and workplace-safe.

const FUN_FACTS = [
  // ── Space ───────────────────────────────────────────────────────────────────
  'Venus has a day longer than its year — it takes longer to spin once on its axis than to orbit the Sun.',
  'Saturn is so light for its size that it would float if you could find a bathtub big enough.',
  'The footprints astronauts left on the Moon could last millions of years, since there is no wind or water to erase them.',
  'One million Earths could fit inside the Sun, which makes up about 99.8% of all the mass in our solar system.',
  "Jupiter's Great Red Spot is a storm wider than our entire planet that has been swirling for centuries.",
  'Olympus Mons on Mars is the tallest known volcano in the solar system — roughly three times the height of Mount Everest.',

  // ── Animals ─────────────────────────────────────────────────────────────────
  "Sea otters hold hands while they sleep so they don't drift apart on the water.",
  'A group of flamingos is called a "flamboyance."',
  'Sloths can hold their breath longer than dolphins — up to 40 minutes — by slowing their heart rate.',
  'Cows form close friendships and can become stressed when separated from their best friend.',
  "A shrimp's heart is located in its head.",
  'Hummingbirds are the only birds that can fly backwards.',
  "Cats can't taste sweetness — they're missing the receptor for it entirely.",
  "Koalas have fingerprints so similar to ours that they've been mistaken for human prints at crime scenes.",
  'Tardigrades, tiny water-dwelling animals, can survive the vacuum of outer space.',
  'The blue whale is the largest animal known to have ever lived — bigger than any dinosaur.',
  'Reindeer eyes change color from gold in summer to blue in winter.',
  'Butterflies taste with their feet.',
  'Gentoo penguins "propose" to a mate by offering a carefully chosen pebble.',
  'A group of giraffes is called a "tower."',

  // ── History ─────────────────────────────────────────────────────────────────
  'Oxford University was already teaching students before the Aztec Empire existed.',
  'Cleopatra lived closer in time to the first Moon landing than to the building of the Great Pyramid.',
  'The Great Pyramid of Giza was the tallest human-made structure on Earth for nearly 4,000 years.',
  'The fax machine was invented decades before the telephone.',
  'Carrots were originally purple; the familiar orange variety was cultivated later in the Netherlands.',
  'Ketchup was sold in the 1830s as a medicine.',
  'Napoleon was actually an average height for his time — his "short" reputation came mostly from propaganda and a mix-up over measurement units.',
  'The Eiffel Tower was built as a temporary exhibit and was nearly torn down.',
  'Roman concrete actually grows stronger over time, especially in seawater.',
  'The Aztecs used cacao beans as a form of currency.',

  // ── Food & drink ────────────────────────────────────────────────────────────
  'Saffron is worth more than its weight in gold because each thread is hand-picked from a crocus flower.',
  "Apples float in water because they're about a quarter air.",
  "Peanuts aren't nuts at all — they're legumes, more closely related to beans and lentils.",
  "White chocolate isn't technically chocolate, since it contains no cocoa solids.",
  'A pineapple plant takes about two years to grow a single fruit.',
  "Fresh cranberries bounce when they're ripe.",
  'The holes in Swiss cheese are bubbles left behind by gas-producing bacteria.',
  'Pound cake got its name from its original recipe: a pound each of butter, sugar, eggs, and flour.',

  // ── Language & words ─────────────────────────────────────────────────────────
  'The word "set" has historically had more distinct dictionary meanings than any other word in English.',
  'The dot over a lowercase "i" or "j" has a name: it\'s called a "tittle."',
  '"Bookkeeper" is one of the only common English words with three consecutive sets of double letters.',
  'The word "nerd" first appeared in a Dr. Seuss book in 1950.',
  'No common English word forms a perfect rhyme with "orange," "month," "silver," or "purple."',
  'The "@" symbol is called a "snail" in Italian and an "elephant\'s trunk" in Danish.',
  'A "jiffy" is a real, measurable unit of time used in physics.',
  'The email term "spam" comes from a Monty Python comedy sketch.',
  'The infinity symbol has a proper name — it\'s called a "lemniscate."',

  // ── Geography ────────────────────────────────────────────────────────────────
  'Russia is so wide it spans 11 time zones.',
  "Canada has more lakes than the rest of the world's countries combined.",
  'Africa is the only continent that sits in all four hemispheres.',
  'Australia is wider than the Moon.',
  'The Norwegian town of Rjukan uses giant mountainside mirrors to bounce sunlight into its town square during the dark winter.',
  'Because Earth bulges at the equator, the peak of Mount Chimborazo in Ecuador — not Everest — is the point farthest from Earth\'s center.',
  'Istanbul is the only major city that straddles two continents.',
  'At Point Nemo, the most remote spot in the ocean, the nearest people are often astronauts passing overhead on the Space Station.',
  'The Sahara Desert occasionally gets snowfall.',
  "The Pacific Ocean is larger than all of Earth's landmasses combined.",
  'The shortest scheduled passenger flight in the world lasts under two minutes, hopping between two Scottish islands.',

  // ── Human body ───────────────────────────────────────────────────────────────
  "You're slightly taller in the morning, because the cartilage in your spine compresses over the course of the day.",
  'Humans share roughly 60% of their DNA with bananas.',
  'Your brain uses about 20% of your body\'s energy while making up only about 2% of its weight.',
  'Goosebumps are a leftover reflex from when our ancestors had much more body hair.',
  'We blink so often that our eyes are closed for a cumulative several minutes of every waking hour.',
  'The jaw muscle is the strongest muscle in the human body for its size.',
  'Petrichor is the name for that earthy smell after rain — and humans are remarkably good at detecting it.',

  // ── Science ──────────────────────────────────────────────────────────────────
  'Under the right conditions, hot water can freeze faster than cold water — a puzzle known as the Mpemba effect.',
  'A bolt of lightning is about five times hotter than the surface of the Sun.',
  'Helium was discovered on the Sun before it was ever found on Earth.',
  'If you could fold a single sheet of paper 42 times, it would reach all the way to the Moon.',
  'Bananas are very slightly radioactive, thanks to the potassium they contain.',
  'The idea that old glass is a slow-moving liquid is a myth — wavy antique windows are just a result of how the glass was made.',
  'Lightning strikes the Earth around 8 million times every day.',
  'A rainbow is actually a full circle; from the ground we usually only see the top arc.',

  // ── Technology ───────────────────────────────────────────────────────────────
  'The very first computer mouse was carved out of wood.',
  "The world's first webcam was created to watch a coffee pot so researchers wouldn't walk over to an empty one.",
  'The first text message ever sent simply read "Merry Christmas," in 1992.',
  'The first item ever sold on eBay was a broken laser pointer.',
  '"Wi-Fi" doesn\'t actually stand for anything — it\'s just a catchy brand name.',
  'Email existed before the World Wide Web.',
  'The "save" icon in most apps is a floppy disk, a device many people have now never used.',
  'The QWERTY keyboard layout was designed back in the 1870s for mechanical typewriters.',
  'The first commercial hard drive, from 1956, was the size of a wardrobe and stored only about 5 megabytes.',

  // ── Art & music ──────────────────────────────────────────────────────────────
  'Leonardo da Vinci was ambidextrous and could reportedly write with one hand while drawing with the other.',
  'The "Happy Birthday" song was under copyright until 2016.',
  'The Mona Lisa has no visible eyebrows.',
  '"Twinkle, Twinkle, Little Star," the alphabet song, and "Baa, Baa, Black Sheep" all share the exact same melody.',
  'The blue pigment ultramarine was once more valuable than gold, because it was ground from the gemstone lapis lazuli.',
  'One piece of organ music in Germany is being performed so slowly that it will take 639 years to finish.',

  // ── Sports ───────────────────────────────────────────────────────────────────
  'Golf was the first sport ever played on the Moon, when an astronaut hit two golf balls there in 1971.',
  'Olympic "gold" medals are actually made mostly of silver, with only a thin gold coating.',
  'Basketball was invented using an actual peach basket as the first hoop.',
  "In the earliest rules of basketball, players weren't allowed to dribble — only to pass.",
  'The longest professional tennis match lasted more than 11 hours, played over three days.',
  'A regulation baseball has exactly 108 stitches.',

  // ── Nature ───────────────────────────────────────────────────────────────────
  'Some species of bamboo can grow nearly a meter in a single day, making it the fastest-growing plant on Earth.',
  'Trees can share nutrients and even warning signals through underground fungal networks nicknamed the "wood wide web."',
  'There are more trees on Earth than there are stars in the Milky Way.',
  'The largest living organism on Earth is a honey fungus in Oregon that stretches across more than 2,000 acres.',
  'Antarctica is technically the largest desert in the world.',
  "Sunflowers turn to follow the Sun across the sky while they're still growing.",

  // ── Batch 2 ─────────────────────────────────────────────────────────────────
  // Space
  'Neutron stars can spin hundreds of times per second, making them some of the fastest-spinning objects in the universe.',
  "On Mars, sunsets glow blue near the Sun, because fine dust in the atmosphere scatters light differently than Earth's air does.",
  // Animals
  'Ravens can imitate sounds, including some human words, and have been known to mimic other animals.',
  'Crows can recognize individual human faces and remember them for years.',
  'Honeybees tell each other the direction and distance of food using a movement called the "waggle dance."',
  'Puffins can hold several small fish in their beaks at once, thanks to backward-facing spines in their mouths that grip the catch.',
  // History
  'The shortest war in recorded history lasted about 38 minutes, fought between the United Kingdom and Zanzibar in 1896.',
  "The London Underground is the world's oldest underground railway, opening in 1863.",
  // Food & drink
  'Pistachios are one of the few nuts that naturally split open on the tree as they ripen.',
  'Vanilla comes from the fruit of an orchid — one of the only widely used spices derived from an orchid.',
  // Language & words
  'In some old schoolbooks the ampersand (&) was treated as the 27th letter of the alphabet.',
  'One of the longest single-syllable words in English is "screeched."',
  // Geography
  "Norway's Lærdal Tunnel is one of the world's longest road tunnels, stretching more than 15 miles.",
  'Madagascar is home to thousands of plant and animal species found nowhere else on Earth.',
  // Human body
  'Fingernails typically grow about three times faster than toenails.',
  'Babies are born with around 300 bones, but many fuse together over time, leaving adults with 206.',
  'Smell is closely tied to memory, because scent signals connect directly to the brain regions handling emotion and recollection.',
  'Laid end to end, the blood vessels in a single human body would stretch for tens of thousands of miles.',
  // Science
  'At a specific pressure and temperature called the triple point, water can boil and freeze at the same time.',
  'Diamond and pencil graphite are both made of pure carbon — the dramatic difference comes entirely from how the atoms are arranged.',
  // Technology
  'QR codes still scan correctly even when partly damaged, because they include built-in error correction.',
  // Art & music
  'Vincent van Gogh sold only one confirmed painting during his lifetime.',
  'A standard piano has 88 keys — 52 white and 36 black.',
  'The largest playable pipe organs have more than 30,000 individual pipes.',
  'The violin, viola, cello, and double bass all belong to the same string family but are tuned differently.',
  // Sports
  'The dimples on a golf ball cut air resistance, helping it fly much farther than a smooth ball would.',
  'Curling stones are made from a rare, dense granite tough enough to survive repeated freezing and impact.',
  'The marathon distance of 26.2 miles became the standard used at the 1924 Olympics, after varying in earlier races.',
  // Nature
  'Some pine cones stay sealed shut until the intense heat of a wildfire opens them, dropping seeds onto freshly cleared ground.',

  // ── Batch 3 ─────────────────────────────────────────────────────────────────
  // Space
  "Saturn's moon Titan has lakes, rivers, and rain — but made of liquid methane and ethane instead of water.",
  'A giant interstellar cloud near the center of the Milky Way, Sagittarius B2, contains enormous amounts of alcohol molecules drifting in space.',
  // Animals
  'Wombats produce cube-shaped droppings — the flat sides keep them from rolling away.',
  'Atlantic puffins have been spotted using small sticks to scratch their own backs, making them one of the few birds known to use tools.',
  'Cows have regional accents in their moos, picking up subtle differences from the herd they grow up in.',
  // History
  'The oldest known customer-service complaint is a 3,750-year-old clay tablet from Mesopotamia, where a man named Nanni complained about receiving the wrong grade of copper.',
  'In 1859, a massive solar storm called the Carrington Event made telegraph lines spark — some operators kept sending messages even after disconnecting their batteries.',
  'The ancient Romans prized a wild herb called silphium so much that they harvested it into complete extinction by around the first century.',
  'Before alarm clocks, British and Irish towns employed "knocker-uppers" who tapped on bedroom windows with long poles to wake people for work.',
  "The world's oldest continuously operating university was founded in 859 by Fatima al-Fihri, a woman in Fez, Morocco.",
  // Language & words
  'The word "clue" comes from "clew," an old word for a ball of thread — a nod to the Greek myth of using thread to escape a labyrinth.',
  '"Scuba" is actually an acronym: Self-Contained Underwater Breathing Apparatus.',
  // Food & drink
  "Wasabi's spicy kick fades fast because its flavor compounds are volatile and water-soluble, which is why chefs grate it fresh right before serving.",
  'Traditional balsamic vinegar is aged at least 12 years in a series of casks made from different woods — chestnut, cherry, oak, mulberry, and ash — each adding its own flavor.',
  // Geography
  'Lesotho is the only country on Earth that lies entirely above 1,000 meters of elevation.',
  'The Haskell Free Library and Opera House straddles the Canada–US border: the audience sits in one country while the stage stands in the other.',
  'Glacier ice looks blue because the weight of packed snow squeezes out air bubbles, leaving dense crystals that absorb red light and scatter blue.',
  // Human body
  'Humans are the only animals known to cry emotional tears — other species only produce tears to clean or protect their eyes.',
  'The cornea is one of the only parts of the body with no blood supply; it absorbs oxygen directly from the air.',
  'Your sense of smell mostly switches off while you sleep, which is why smoke alarms rely on loud sound rather than odor to wake you.',
  // Science
  'Sound travels almost four times faster through water than through air, because water molecules are packed more closely together.',
  // Technology
  'The first registered internet domain name was Symbolics.com, claimed by a Massachusetts computer company in March 1985.',
  'The term computer "bug" took off in 1947, when Grace Hopper\'s team found an actual moth stuck inside the Harvard Mark II computer.',
  // Art & music
  'While designing the Sydney Opera House, architect Jørn Utzon reportedly cracked the puzzle of its sweeping shells while peeling an orange into even segments.',
  'Leonardo da Vinci returned to the Mona Lisa for years, building her subtle expression from many microscopically thin layers of glaze.',
  'Salvador Dalí is said to have dodged restaurant bills by sketching on the back of his checks, betting the owners would never cash original art.',
  'Michelangelo painted the Sistine Chapel ceiling standing upright on custom scaffolding — not lying on his back, as the popular myth claims.',
  // Sports
  'Tug-of-war was an official Olympic sport from 1900 to 1920, and a single country could enter several teams and sweep the medals.',
  'The yellow tennis balls used today were adopted at Wimbledon in 1986, because white balls were hard to see on color television.',
  // Nature
  'Pando, a grove of quaking aspens in Utah, is actually one organism sharing a single root system — among the heaviest and oldest living things on Earth.',
  'Some desert sand dunes "sing," producing a low booming hum as millions of grains slide down the slope together in dry conditions.',
  'Pearls form when an irritant slips inside a mollusk, which slowly coats it in thousands of microscopic layers of shimmering aragonite.',
];

module.exports = { FUN_FACTS };
