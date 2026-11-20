# Etiquetas Shopee com produto

Site estático (GitHub Pages) que lê o `.zip` **"Etiqueta de Envio ZPL + Declaração de Conteúdo + Lista de Empacotamento"** baixado na Shopee e devolve as etiquetas prontas, com o nome do produto escrito na faixa em branco de cada uma.

## O que faz

- Lê as etiquetas ZPL (imagem `~DG` / `^GF`, compressão Z64, B64 ou hex).
- Lê o QR da DACE impresso em cada etiqueta e casa com a **declaração de conteúdo** pela chave de acesso, então o produto sai certo mesmo com a ordem embaralhada.
- Puxa a **variação** (cor etc.) da lista de empacotamento.
- Escreve `Qtd x Produto · Variação` só na faixa totalmente em branco entre o código da rota e o código de barras. Nenhum código é coberto.
- Apelido curto por produto, salvo no navegador.
- Saídas: impressão 10×15 cm, download do **ZPL com produto** (mesmo formato da Shopee, para impressora térmica) e lista de separação em A4.

## Privacidade

Tudo roda no navegador. Nenhum arquivo é enviado para servidor. Não suba arquivos de clientes para este repositório.

## Publicar

Settings → Pages → *Deploy from a branch* → `main` / `(root)`.

Bibliotecas incluídas em `vendor/`: pdf.js (Apache-2.0), JSZip (MIT), jsQR (Apache-2.0).
