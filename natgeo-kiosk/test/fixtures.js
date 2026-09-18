// Synthetic pages that mimic the shapes a modern publisher CMS emits. Each one
// exercises a different extraction strategy so a regression in any single
// strategy is caught, and so the merge logic is tested on conflicting inputs.

export const MAGAZINE_JSONLD = `<!DOCTYPE html>
<html><head>
<title>October 2026 Issue | National Geographic</title>
<meta property="og:title" content="The October 2026 Issue">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"CollectionPage","name":"October 2026",
 "itemListElement":[
  {"@type":"ListItem","item":{"@type":"Article","url":"https://www.nationalgeographic.com/magazine/article/deep-sea-vents","headline":"Life at the Vents"}},
  {"@type":"ListItem","item":{"@type":"Article","url":"https://www.nationalgeographic.com/magazine/article/sahara-nomads","headline":"The Last Nomads"}}
 ]}
</script>
</head><body>
<a href="/subscribe">Subscribe</a>
<a href="/magazine/article/deep-sea-vents">Life at the Vents</a>
</body></html>`;

export const MAGAZINE_NEXTDATA = `<!DOCTYPE html>
<html><head><title>National Geographic Magazine</title></head><body>
<h1>November 2026</h1>
<script id="__NEXT_DATA__" type="application/json">
{"props":{"pageProps":{"issue":{"displayTitle":"November 2026","components":[
  {"type":"promo","url":"https://www.nationalgeographic.com/magazine/article/ice-cores","title":"Reading the Ice"},
  {"type":"promo","url":"https://www.nationalgeographic.com/magazine/article/urban-foxes","title":"City Foxes"},
  {"type":"promo","url":"https://www.nationalgeographic.com/newsletters","title":"Sign up"}
]}}}}
</script>
</body></html>`;

export const MAGAZINE_ANCHORS_ONLY = `<!DOCTYPE html>
<html><head><title>Magazine</title></head><body>
<h2>December 2026</h2>
<nav><a href="/subscribe">Subscribe</a><a href="/account">Account</a></nav>
<main>
<a href="https://www.nationalgeographic.com/magazine/article/river-dolphins">River Dolphins</a>
<a href="https://www.nationalgeographic.com/history/article/pompeii-dig">Pompeii</a>
<a href="/tag/oceans">Oceans</a>
<a href="/magazine">Magazine</a>
</main></body></html>`;

export const ARTICLE_FIGURES = `<!DOCTYPE html>
<html><head>
<title>Life at the Vents</title>
<meta property="og:title" content="Life at the Vents">
<meta property="og:image" content="https://i.natgeofe.com/n/hero-vents.jpg?w=1200">
<meta name="description" content="Hydrothermal vents teem with life.">
</head><body>
<a>Sign out</a>
<h1>Life at the Vents</h1>
<figure>
  <picture>
    <source srcset="https://i.natgeofe.com/n/vent-01.jpg?w=800 800w, https://i.natgeofe.com/n/vent-01.jpg?w=2400 2400w">
    <img src="https://i.natgeofe.com/n/vent-01.jpg?w=400" alt="A tubeworm colony">
  </picture>
  <figcaption>
    A colony of giant tubeworms crowds a hydrothermal vent two miles below the
    surface of the Pacific Ocean, near the Galápagos Rift.
    <span class="credit">Photograph by Maria Chen</span>
  </figcaption>
</figure>
<figure>
  <img src="https://i.natgeofe.com/n/vent-02.jpg?w=1600" alt="Vent chimney">
  <figcaption>A black smoker chimney vents superheated water.</figcaption>
</figure>
<p>Photographs by Maria Chen</p>
</body></html>`;

export const ARTICLE_JSON_EMBEDDED = `<!DOCTYPE html>
<html><head>
<title>The Last Nomads</title>
<meta property="og:title" content="The Last Nomads">
</head><body>
<a href="/account">My Account</a>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"NewsArticle","headline":"The Last Nomads",
 "author":{"@type":"Person","name":"Amara Diallo"},
 "image":{"@type":"ImageObject","url":"https://i.natgeofe.com/n/nomad-hero.jpg?w=1000",
          "caption":"A caravan crosses the dunes at dawn.","creditText":"Amara Diallo"}}
</script>
<script>
window.__PAGE__ = {"body":[
  {"type":"image","src":"https://i.natgeofe.com/n/nomad-02.jpg?w=1200",
   "dsc":"Salt slabs are loaded onto camels in the Taoudenni basin of northern Mali.",
   "credit":"Amara Diallo","width":1200},
  {"type":"text","content":"The caravan moves at night."}
]};
</script>
</body></html>`;

export const ARTICLE_PAYWALLED = `<!DOCTYPE html>
<html><head><title>Subscribers only</title></head><body>
<h1>This story is for subscribers</h1>
<p>Already a subscriber? Sign in to continue reading.</p>
<p>Start your subscription today.</p>
</body></html>`;
