# API do Painel de Qualidade Moinho Regio

Este pacote contém o painel HTML e uma API Node.js sem dependências externas. Ela preserva os dados sincronizados em um arquivo JSON e protege o painel por login e os endpoints de integração por token Bearer.

## Endpoints

- `GET /api/health` — teste simples de disponibilidade.
- `GET /api/data` — base que o painel lê; exige login do painel.
- `POST /api/import` — importação pelo próprio painel; exige login.
- `POST /api/powerautomate/import` — recebe a base enviada pelo Power Automate; exige `Authorization: Bearer SEU_API_TOKEN`. Substitui a base sincronizada, então o fluxo deve enviar **todas as linhas atuais da tabela**, não apenas a linha nova.
- `GET /api/powerautomate/data` — devolve a base atual para integrações; exige o mesmo token.

A resposta de importação inclui `ok`, `updated_at`, `record_count` e `source`. O painel verifica `/api/data` a cada 30 segundos quando está aberto.

## Configuração local

Requer Node.js 20.6 ou superior.

1. Copie `.env.example` para `.env`.
2. Defina `APP_USER`, `APP_PASSWORD`, `API_TOKEN` e `SESSION_SECRET` com valores fortes. A senha precisa ter 12 caracteres ou mais; token e segredo, 32 caracteres ou mais. Gere valores aleatórios no PowerShell com `node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"`. Use valores diferentes para `API_TOKEN` e `SESSION_SECRET`.
3. Execute `npm start`.
4. Abra `http://localhost:3000` e entre com o usuário e a senha configurados.
5. Teste `http://localhost:3000/api/health`.

Nunca publique o `.env`, envie o token por mensagens abertas ou coloque o token dentro do HTML. Use HTTPS em produção.

## Configurar o Power Automate

Crie um fluxo com uma ação **Listar linhas presentes em uma tabela** (Excel Online (Business)) para obter a tabela completa da planilha. Ative a paginação da ação se a tabela puder ultrapassar o limite padrão do conector. Depois adicione a ação HTTP com:

- Método: `POST`
- URI: `https://SEU-DOMINIO/api/powerautomate/import`
- Cabeçalho `Authorization`: `Bearer SEU_API_TOKEN`
- Cabeçalho `Content-Type`: `application/json`
- Corpo: envie `source` e a lista de objetos devolvida pelo Excel. Cada objeto precisa usar nomes de coluna equivalentes aos cabeçalhos da planilha usada pelo painel.

Exemplo de corpo para teste (use dados reais ao configurar o fluxo):

```json
{
  "source": "Power Automate - Excel Online",
  "rows": [
    {
      "Data": "2026-10-21",
      "Fornecedor": "FORNECEDOR EXEMPLO",
      "Armazenamento": "D1",
      "Umidade (%) — trigo": 12.4,
      "Falling Number — trigo": 280,
      "W": 240,
      "P/L": 0.8
    }
  ]
}
```

No fluxo real, substitua o array de exemplo pela saída completa da ação de listar linhas (conteúdo dinâmico `value`). A API reconhece tanto linhas em formato de objeto quanto o formato `headers` + `rows` em matriz, que o painel já envia. As colunas ausentes em uma linha ficam vazias. A data pode ser ISO (`2026-10-21`), data/hora ISO ou `dd/mm/aaaa`.

### Corpo do HTTP usando saída de Excel

No editor de expressão do Power Automate, use `body('Listar_linhas_presentes_em_uma_tabela')?['value']` para selecionar a lista retornada pela ação (o nome interno da ação pode ser diferente). Estruture o corpo HTTP com `source` e `rows`, atribuindo a `rows` essa saída dinâmica. O Power Automate deve enviar todos os registros atuais da tabela em cada sincronização.

## Hospedagem e segurança

O HTML sozinho não cria uma API. Publique esta pasta em um servidor Node.js que aceite requisições HTTPS e configure as variáveis de ambiente no serviço de hospedagem. Configure `DATA_FILE` apontando para armazenamento persistente; caso contrário, algumas plataformas podem perder o arquivo JSON durante uma nova implantação ou reinicialização. Para produção corporativa, prefira hospedar em infraestrutura aprovada pela TI e limitar o acesso por rede/identidade corporativa. O login deste pacote protege a visualização do painel, e o token Bearer protege o acesso de Power Automate à API; mantenha o token em uma conexão/variável segura do fluxo.

A API não cria automaticamente a URL pública. A URL final será a do domínio atribuído pela hospedagem.
