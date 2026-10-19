import fs from 'node:fs/promises';
const descriptions = {
  en: `AI assistance for Moodle assignment grading, with the teacher in control.

Open the correction sidebar from the extension icon. Review detected grading mode, assignment references and submitted files. Set teacher criteria for the course, assignment and individual case. Request a suggestion and review the proposed feedback, numeric grade or rubric levels in the editable Moodle form. The extension never saves or submits that form; you decide what to save.

Connect Ollama, LM Studio, llama.cpp, LocalAI, vLLM, another compatible local server, or an OpenAI-compatible API. Configure the server address, port and model in Simple or Advanced settings. Keys are stored for the Chrome session only. HTTP local servers can be used on a trusted network; use HTTPS for sensitive traffic.

Supported evidence includes PDF, DOCX, ODT, text files and supported images. Image evidence requires a vision-capable model. Unsupported formats are marked and skipped. The panel distinguishes assignment explanations from student work.

Interface: English, Spanish, French, German, Portuguese, Italian, Galician and Catalan. Browser detection and manual language selection are included.

Moodle context is sent directly to the selected AI provider only when you request a correction. MoodlIA receives no student work. Content may contain personal data: use a provider approved by your institution and review every suggestion. Independent open-source project, not affiliated with Moodle HQ.`,
  es: `Asistencia de IA para corregir tareas de Moodle, con el docente al mando.

Abre el panel lateral desde el icono. Revisa el modo de evaluación, los documentos del enunciado y las entregas. Añade criterios docentes por curso, por tarea y por caso concreto. Solicita una sugerencia y revisa los comentarios, la nota o los niveles de rúbrica en el formulario editable de Moodle. La extensión nunca guarda ni envía ese formulario: tú decides qué guardar.

Conecta Ollama, LM Studio, llama.cpp, LocalAI, vLLM, otro servidor local compatible o una API compatible con OpenAI. Configura dirección, puerto y modelo en modo Simple o Avanzado. Las claves duran solo la sesión de Chrome. Puedes usar servidores locales por HTTP en redes de confianza; utiliza HTTPS para tráfico sensible.

Admite PDF, DOCX, ODT, texto e imágenes compatibles. Las imágenes requieren un modelo con visión. Los formatos no soportados se indican y omiten. El panel distingue los documentos explicativos del trabajo del alumno.

Interfaz en inglés, español, francés, alemán, portugués, italiano, gallego y catalán, con detección del navegador y selección manual.

El contexto de Moodle se envía directamente al proveedor elegido solo al solicitar una corrección. MoodlIA no recibe trabajos del alumnado. El contenido puede incluir datos personales: usa un proveedor autorizado por tu centro y revisa cada sugerencia. Proyecto independiente de código abierto, sin afiliación con Moodle HQ.`,
  fr: `Une aide IA à la correction des devoirs Moodle, sous le contrôle de l’enseignant.

Ouvrez le panneau latéral depuis l’icône. Vérifiez la méthode d’évaluation, les documents de référence et les travaux remis. Définissez des critères pour le cours, le devoir et le cas individuel. Demandez une suggestion puis vérifiez les commentaires, la note ou les niveaux de grille dans le formulaire Moodle modifiable. L’extension n’enregistre et n’envoie jamais ce formulaire : vous décidez.

Connectez Ollama, LM Studio, llama.cpp, LocalAI, vLLM, un autre serveur local compatible ou une API compatible OpenAI. Configurez adresse, port et modèle en mode Simple ou Avancé. Les clés sont conservées uniquement pour la session Chrome. HTTP est possible sur un réseau de confiance ; utilisez HTTPS pour les données sensibles.

PDF, DOCX, ODT, texte et images compatibles sont pris en charge. Les images nécessitent un modèle avec vision. Les formats non pris en charge sont signalés et ignorés. Les références du devoir restent distinctes du travail de l’élève.

Huit langues d’interface : anglais, espagnol, français, allemand, portugais, italien, galicien et catalan.

Le contexte est envoyé directement au fournisseur choisi uniquement lors d’une demande de correction. MoodlIA ne reçoit aucun travail d’élève. Utilisez un fournisseur autorisé par votre établissement et vérifiez chaque suggestion. Projet libre indépendant, sans affiliation avec Moodle HQ.`,
  de: `KI-Unterstützung für die Bewertung von Moodle-Aufgaben. Die Lehrkraft entscheidet.

Öffnen Sie die Seitenleiste über das Erweiterungssymbol. Prüfen Sie Bewertungsmethode, Aufgabenreferenzen und abgegebene Dateien. Legen Sie Vorgaben für Kurs, Aufgabe und Einzelfall fest. Fordern Sie einen Vorschlag an und prüfen Sie Feedback, Note oder Rasterstufen im bearbeitbaren Moodle-Formular. Die Erweiterung speichert oder sendet dieses Formular niemals automatisch.

Verbinden Sie Ollama, LM Studio, llama.cpp, LocalAI, vLLM, einen anderen kompatiblen lokalen Server oder eine OpenAI-kompatible API. Adresse, Port und Modell lassen sich im einfachen oder erweiterten Modus einstellen. Schlüssel werden nur für die Chrome-Sitzung gespeichert. HTTP ist in vertrauenswürdigen lokalen Netzen möglich; für sensible Übertragungen HTTPS verwenden.

PDF, DOCX, ODT, Textdateien und unterstützte Bilder sind verwendbar. Bilder erfordern ein Modell mit Bildverarbeitung. Nicht unterstützte Formate werden markiert und übersprungen. Referenzmaterial und Schülerarbeit bleiben getrennt.

Oberfläche in Englisch, Spanisch, Französisch, Deutsch, Portugiesisch, Italienisch, Galicisch und Katalanisch.

Moodle-Inhalte werden nur bei einer Korrekturanforderung direkt an den gewählten Anbieter gesendet. MoodlIA erhält keine Schülerarbeiten. Nutzen Sie einen von Ihrer Einrichtung zugelassenen Anbieter und prüfen Sie jeden Vorschlag. Unabhängiges Open-Source-Projekt ohne Verbindung zu Moodle HQ.`,
  pt_BR: `Assistência de IA para avaliar tarefas do Moodle, com o professor no controle.

Abra o painel lateral pelo ícone. Confira o método de avaliação, as referências da tarefa e os arquivos enviados. Defina critérios por curso, tarefa e caso específico. Solicite uma sugestão e revise comentários, nota ou níveis da rubrica no formulário editável do Moodle. A extensão nunca salva nem envia esse formulário automaticamente.

Conecte Ollama, LM Studio, llama.cpp, LocalAI, vLLM, outro servidor local compatível ou uma API compatível com OpenAI. Configure endereço, porta e modelo nos modos Simples ou Avançado. As chaves duram apenas a sessão do Chrome. HTTP pode ser usado em redes locais confiáveis; use HTTPS para dados sensíveis.

Suporte a PDF, DOCX, ODT, texto e imagens compatíveis. Imagens exigem um modelo com visão. Formatos não suportados são indicados e ignorados. Referências e trabalho do aluno permanecem separados.

Interface em inglês, espanhol, francês, alemão, português, italiano, galego e catalão.

O contexto do Moodle é enviado diretamente ao provedor escolhido somente ao solicitar uma correção. O MoodlIA não recebe trabalhos dos alunos. Use um provedor autorizado pela sua instituição e revise cada sugestão. Projeto independente de código aberto, sem vínculo com o Moodle HQ.`,
  it: `Assistenza IA per valutare i compiti Moodle, con il docente al controllo.

Apri il pannello laterale dall’icona. Controlla il metodo di valutazione, i riferimenti del compito e i file consegnati. Imposta criteri per corso, compito e caso individuale. Richiedi un suggerimento e controlla commenti, voto o livelli della rubrica nel modulo Moodle modificabile. L’estensione non salva né invia mai automaticamente il modulo.

Collega Ollama, LM Studio, llama.cpp, LocalAI, vLLM, un altro server locale compatibile o un’API compatibile con OpenAI. Configura indirizzo, porta e modello nelle modalità Semplice o Avanzate. Le chiavi sono conservate solo per la sessione Chrome. HTTP è utilizzabile in reti locali fidate; usa HTTPS per dati sensibili.

Supporta PDF, DOCX, ODT, testo e immagini compatibili. Le immagini richiedono un modello con visione. I formati non supportati sono segnalati e ignorati. Materiale di riferimento e lavoro dello studente restano distinti.

Interfaccia in inglese, spagnolo, francese, tedesco, portoghese, italiano, galiziano e catalano.

Il contesto viene inviato direttamente al provider scelto solo quando richiedi una correzione. MoodlIA non riceve lavori degli studenti. Usa un provider autorizzato dall’istituto e verifica ogni suggerimento. Progetto open source indipendente, non affiliato a Moodle HQ.`,
  gl: `Asistencia de IA para corrixir tarefas de Moodle, co docente ao mando.

Abre o panel lateral desde a icona. Revisa o método de avaliación, os documentos de referencia e as entregas. Engade criterios por curso, tarefa e caso concreto. Solicita unha suxestión e revisa os comentarios, a nota ou os niveis da rúbrica no formulario editable de Moodle. A extensión nunca garda nin envía ese formulario automaticamente.

Conecta Ollama, LM Studio, llama.cpp, LocalAI, vLLM, outro servidor local compatible ou unha API compatible con OpenAI. Configura enderezo, porto e modelo en modo Simple ou Avanzado. As claves duran só a sesión de Chrome. Podes usar HTTP en redes locais de confianza; usa HTTPS para datos sensibles.

Admite PDF, DOCX, ODT, texto e imaxes compatibles. As imaxes requiren un modelo con visión. Os formatos non compatibles indícanse e omítense. As referencias e o traballo do alumno mantéñense separados.

Interface en inglés, español, francés, alemán, portugués, italiano, galego e catalán.

O contexto de Moodle envíase directamente ao provedor elixido só ao pedir unha corrección. MoodlIA non recibe traballos do alumnado. Usa un provedor autorizado polo centro e revisa cada suxestión. Proxecto independente de código aberto, sen afiliación con Moodle HQ.`,
  ca: `Assistència d’IA per avaluar tasques de Moodle, amb el docent al capdavant.

Obre el tauler lateral des de la icona. Revisa el mètode d’avaluació, els documents de referència i els lliuraments. Afegeix criteris per curs, tasca i cas concret. Demana un suggeriment i revisa els comentaris, la nota o els nivells de rúbrica al formulari editable de Moodle. L’extensió mai no desa ni envia automàticament aquest formulari.

Connecta Ollama, LM Studio, llama.cpp, LocalAI, vLLM, un altre servidor local compatible o una API compatible amb OpenAI. Configura adreça, port i model en mode Simple o Avançat. Les claus només duren la sessió de Chrome. Pots fer servir HTTP en xarxes locals de confiança; fes servir HTTPS per a dades sensibles.

Admet PDF, DOCX, ODT, text i imatges compatibles. Les imatges requereixen un model amb visió. Els formats no compatibles s’indiquen i s’ometen. Les referències i el treball de l’alumne es mantenen separats.

Interfície en anglès, espanyol, francès, alemany, portuguès, italià, gallec i català.

El context de Moodle s’envia directament al proveïdor triat només quan demanes una correcció. MoodlIA no rep treballs de l’alumnat. Fes servir un proveïdor autoritzat pel centre i revisa cada suggeriment. Projecte independent de codi obert, sense afiliació amb Moodle HQ.`,
};
for (const [locale, detailedDescription] of Object.entries(descriptions)) {
  const catalog = JSON.parse(await fs.readFile(`extension/_locales/${locale}/messages.json`, 'utf8'));
  const listing = { locale, name: 'MoodlIA Corrector', summary: catalog.extensionDescription.message, detailedDescription,
    category: 'Education', homepage: 'https://moodlia.com/products/corrector/', supportUrl: 'https://github.com/gafapa/moodlia-corrector/issues', privacyPolicyUrl: 'https://moodlia.com/privacy/corrector.html' };
  await fs.writeFile(`marketplace/listings/${locale}.json`, JSON.stringify(listing, null, 2) + '\n');
}
console.log('Generated eight localized store listings.');
