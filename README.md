# Batalha dos Sabores — Power Nutrifit

Votação com confirmação, contagem compartilhada e ranking separado para pré-treino Fritz e whey. Campanha da degustação de **13 de outubro de 2026**.

**Esta versão precisa do projeto completo. Publicar somente o `index.html` não ativa a votação.** O HTML usa a API da Vercel, que registra os votos no Supabase. Não existe contagem fictícia ou ranking salvo apenas no aparelho.

## Colocar no ar

1. **Supabase:** crie um projeto em [supabase.com](https://supabase.com/). No SQL Editor, cole e execute o conteúdo completo de `database/setup.sql`. Aguarde a conclusão sem erros. O script cria a campanha e as funções de votação; pode ser repetido sem apagar votos.
2. **Credenciais:** no painel do projeto Supabase, copie a URL do projeto e uma chave **Secret**, que começa com `sb_secret_`. A chave fica em **Settings → API Keys**. Não use a chave Publishable. Guarde a Secret somente no painel da Vercel, nunca no HTML ou no GitHub.
3. **GitHub:** extraia o ZIP. Coloque o conteúdo da pasta do projeto na raiz do seu repositório, incluindo `index.html`, `assets`, `api`, `lib`, `scripts`, `package.json` e `vercel.json`. Inclua também `database`, `tests` e este guia para manutenção. Não envie um ZIP fechado para a Vercel.
4. **Vercel:** importe esse repositório. Use **Framework Preset: Other** e a raiz do repositório como Root Directory. O `vercel.json` já define Build Command `npm run build` e Output Directory `public`.
5. **Variáveis:** antes de publicar, adicione as quatro variáveis abaixo ao ambiente **Production**. Se adicioná-las depois, faça um novo deploy.
6. **Conferência:** abra a URL da Vercel, escolha dois sabores e confirme. Em outro navegador, atualize o ranking e confira o mesmo total. Recarregue o primeiro navegador: ele deve mostrar o voto já registrado. Use a orientação de teste abaixo para evitar misturar ensaios com votos de clientes.

| Variável na Vercel | Valor |
| --- | --- |
| `SUPABASE_URL` | URL HTTPS do seu projeto Supabase |
| `SUPABASE_SECRET_KEY` | Chave Secret `sb_secret_...` do mesmo projeto |
| `VOTE_COOKIE_SECRET` | Segredo aleatório de pelo menos 32 caracteres, gerado uma vez |
| `POLL_ID` | `power-2026-10-13` |

Para gerar o segredo no computador com Node.js, use:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copie o resultado diretamente para `VOTE_COOKIE_SECRET` na Vercel. Mantenha o mesmo valor durante a campanha: trocá-lo invalida os identificadores de navegador existentes. Não é necessário colocar nenhuma chave no `index.html`.

## Como funciona

- O cliente escolhe **um Fritz e um whey**. Leitinho da Shark Pro participa da categoria whey.
- O botão **Confirmar meu voto** grava as duas escolhas na mesma operação.
- A confirmação só aparece após o servidor confirmar o registro.
- O ranking mostra posição, número de votos e porcentagem de cada sabor. Uma participação corresponde a um voto em cada categoria.
- O ranking atualiza logo após a confirmação e a cada **15 segundos** enquanto a página estiver visível. Há também atualização manual.
- Os votos são ordenados do maior para o menor. Empates recebem a mesma posição; sabores sem votos não aparecem como líderes.
- Se a conexão falhar, a página avisa e mantém a última contagem recebida identificada como desatualizada. Não inventa resultados.
- O voto confirmado não pode ser alterado. Uma restrição única no banco impede duplicação pelo mesmo identificador, inclusive em reenvios simultâneos.

## Um voto por navegador

Um cookie aleatório, assinado e protegido com `HttpOnly`, identifica o navegador. O banco armazena um hash desse identificador, as duas escolhas e o horário; não solicita nome ou telefone. O ranking é agregado e não expõe identificadores.

Este é um controle básico para uma enquete de loja, não uma autenticação de pessoas. Outro navegador, modo anônimo ou exclusão de cookies podem permitir nova participação. Login ou confirmação por telefone seriam necessários para um controle mais forte. Use uma única URL pública oficial para concentrar a campanha; cookies de domínios diferentes não são compartilhados. Compartilhar o mesmo aparelho também compartilha a participação.

## Encerrar a votação

Quando a Power definir os sabores para o evento, execute no SQL Editor do Supabase:

```sql
update power_private.campaigns
set is_open = false
where id = 'power-2026-10-13';
```

O site passa a mostrar **Votação encerrada**, preserva o ranking e bloqueia novos registros. Não há horário de encerramento inventado: a campanha começa aberta e você decide quando fechar.

Também é possível programar o encerramento pelo campo `closes_at`. Exemplo para encerrar na segunda-feira às 23h59, no horário do Piauí:

```sql
update power_private.campaigns
set closes_at = '2026-10-12 23:59:00-03'
where id = 'power-2026-10-13';
```

Não execute esse exemplo se quiser outro horário. Para reabrir intencionalmente, ajuste `is_open` e `closes_at` no painel.

## Testar sem misturar votos de clientes

`database/verify.sql` contém verificações reais do banco, incluindo soma dos votos, reenvio, fechamento e permissões. Execute no SQL Editor depois do setup. Tudo ocorre em uma transação que termina com `ROLLBACK`, sem acrescentar votos à campanha.

Para ensaiar a interface em uma implantação Preview, use uma campanha de teste separada: crie uma linha com outro `id` em `power_private.campaigns`, configure esse ID em `POLL_ID` no ambiente Preview e use o mesmo valor em `pollId` no HTML da versão de teste. Evite habilitar previews indiscriminadamente com as credenciais da campanha em produção.

## Arquivos

| Arquivo | Função |
| --- | --- |
| `index.html` | Layout responsivo, escolha de sabores, confirmação e tabelas |
| `api/poll.js` | Entrada da função da Vercel |
| `lib/poll-server.js` | Validação, cookie assinado e comunicação com o banco |
| `database/setup.sql` | Banco, gravação atômica, ranking e permissões |
| `database/verify.sql` | Verificações do banco com rollback |
| `assets/` | Fotos dos produtos (WebP) e fontes da marca: Bungee e Montserrat, ambas com licença livre (OFL) |
| `scripts/build.mjs` | Prepara o HTML, as fotos e as fontes para publicação estática |
| `vercel.json` | Configuração da hospedagem e cabeçalhos |
| `tests/` | Testes automatizados locais, sem serviços externos |
| `.env.example` | Nomes das variáveis, sem credenciais reais |

## Verificação técnica

Execute `npm test` para testar a API com uma camada de banco simulada. Execute `npm run build` para preparar a saída estática. Não há dependências npm adicionais.

Os testes locais cobrem confirmação, repetição, isolamento entre navegadores, ranking, erros de conexão e validação. O SQL foi fornecido para execução e conferência no seu Supabase; não foi executado contra uma conta real nesta entrega. A publicação na Vercel e a conferência visual em navegador ainda dependem da configuração na sua conta.

## Se aparecer “A votação ainda não está disponível”

A mensagem termina com um **código** que indica a causa. O mesmo código aparece no campo `reason` ao abrir `/api/poll` no navegador e nos logs da função na Vercel. Depois de corrigir uma variável na Vercel, faça **Deployments → ⋯ → Redeploy**: variáveis alteradas não valem para o deploy que já está no ar.

| Código | Causa provável | Como corrigir |
| --- | --- | --- |
| `SUPABASE_URL` | Variável vazia, só o código do projeto, com a string de conexão `postgresql://` ou com o endereço do painel `supabase.com/dashboard/...` | Use a Project URL, no formato `https://abcd1234.supabase.co` |
| `SUPABASE_SECRET_KEY` | Variável vazia, chave antiga `eyJ...`, chave Publishable ou chave copiada mascarada (`sb_secret_xxxxx••••`) | Em **Settings → API Keys**, clique no ícone de copiar ao lado da chave Secret. Selecionar o texto copia só a parte visível |
| `VOTE_COOKIE_SECRET` | Menos de 32 caracteres | Gere um segredo novo, conforme o início deste guia |
| `POLL_ID` | Espaços ou caracteres inválidos no meio | Use `power-2026-10-13` |
| `DATABASE_UNREACHABLE` | O endereço do Supabase não respondeu: URL errada ou projeto pausado | Confira a URL e se o projeto está ativo no painel |
| `DATABASE_KEY` | O Supabase recusou a chave: é de outro projeto, foi revogada ou foi copiada incompleta | Copie de novo a Secret do **mesmo** projeto da URL |
| `DATABASE_SETUP` | As funções de votação não foram encontradas: `setup.sql` rodou em outro projeto ou a Data API está desativada | Rode `database/setup.sql` no projeto da URL e confira se a Data API está ativa |
| `CAMPAIGN_NOT_FOUND` | O `POLL_ID` não existe no banco | Use `power-2026-10-13` ou crie a campanha com esse ID |
| `DATABASE_API` | A Data API do Supabase está desativada | Em **Integrations → Data API**, ative **Enable Data API** e confira se `public` está em **Exposed schemas** |
| `DATABASE_ERROR`, `DATABASE_RESPONSE` | Resposta inesperada do banco | Rode `database/setup.sql` de novo e confira os logs da função |
| `API_404` | A função `api/poll.js` não foi publicada | Confira se o projeto foi importado com a pasta `api` e Framework Preset **Other** |
| `API_401`, `API_403` | A Vercel exigiu login antes de liberar a API (proteção de deploy) | Abra o domínio de produção, não o endereço de um deploy específico |
| `INVALID_RESPONSE` | O `POLL_ID` da Vercel é diferente do `pollId` do `index.html` | Use o mesmo ID nos dois |
| `NETWORK` | Sem internet ou tempo esgotado | Tente novamente |

Servir apenas o HTML ou usar GitHub Pages não executa a API.

## Referências de implementação

- [Funções Node.js da Vercel](https://vercel.com/docs/functions/runtimes/node-js)
- [Configuração do build na Vercel](https://vercel.com/docs/builds/configure-a-build)
- [Chaves de API do Supabase](https://supabase.com/docs/guides/getting-started/api-keys)
- [Funções e permissões no Supabase](https://supabase.com/docs/guides/database/functions)

As tabelas ficam no schema privado. As funções do banco são liberadas somente ao papel de servidor `service_role`; a chave Secret nunca é enviada ao navegador. Os endpoints públicos validam categorias, tamanho do corpo e origem. Não há identificação civil, CAPTCHA ou proteção avançada contra fraude automatizada.
