let conversationArr;

// Function to transform ticket conversations
function transformTicketConversations(ticketConversations) {
  // Filter out system and trigger messages, and messages with certain content
  const filteredMessages = ticketConversations.filter(
    (message) =>
      message.author.role &&
      message.author.role !== "system" &&
      message.author.role !== "trigger" &&
      ((message.message.content &&
        message.message.content !== "Joined" &&
        message.message.content !== "Left") ||
        // We only allow messages without content if they have an attachment
        (!message.message.content && message.attachments))
  );

  // Clean up message content
  const cleanedMessageArray = filteredMessages.map((message) => {
    const newMessage = { ...message };
    if (
      newMessage.message.content === null &&
      newMessage.attachments &&
      newMessage.attachments.length > 0
    ) {
      newMessage.message.content = `${newMessage.author.name} added a file named ${newMessage.attachments[0].filename} to this ticket.`;
    }
    if (newMessage.message.contentType === "text/html") {
      newMessage.message.content = newMessage.message.content
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ");
    }
    return newMessage;
  });

  // Transform messages into comments
  const allComments = cleanedMessageArray.map((comment) => {
    const commentText = comment.message.content
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ");

    return {
      is_end_user: comment.author.role === "user",
      is_public: comment.channel.name !== "internal",
      author_id: comment.author.id,
      plain_text: commentText,
      timestamp: comment.timestamp,
    };
  });

  // Return the transformed data
  return {
    comments: allComments,
    messages: cleanedMessageArray,
  };
}

// Function to fetch conversation
const fetchConversation = async () => {
  const conversationResponse = await client.get("ticket.conversation");
  const cleanedMessageArray = await transformTicketConversations(
    conversationResponse["ticket.conversation"]
  );
  conversationArr = cleanedMessageArray.messages;
};

// Function to make OpenAI API call
const generateOpenAIResponse = async (promptType) => {
  const prompt = await promptGenerator(promptType, conversationArr);

  const response = await client.request({
    url: "https://api.openai.com/v1/chat/completions",
    type: "POST",
    contentType: "application/json",
    secure: true,
    headers: {
      Authorization: `Bearer {{setting.openai_api_key}}`,
    },
    data: prompt,
  });

  const formattedResponse = response?.choices[0].message.content.replace(
    /\n/g,
    "<br>"
  );

  client.invoke("ticket.editor.insert", formattedResponse);
};

// Function to generate prompt for OpenAI
async function promptGenerator(promptType, conversationData) {
  // Function to format conversation data for OpenAI prompt
  function formatForOpenAIPrompt(messages) {
    if (!messages || messages.length === 0) {
      return "No conversation data available.";
    }
    console.log("messages", messages);
    const formattedMessages = messages.reduce((formattedPrompt, entry) => {
      // Skip entries with no content
      if (!entry.message || !entry.message.content) {
        console.log("entry", entry);
        return formattedPrompt; // Continue without adding the current entry
      }
      // Format the date for readability
      const timestamp = new Date(entry.timestamp).toLocaleString();

      // Add the conversation entry to the prompt
      formattedPrompt += `[${timestamp}] ${entry.author.name} (${entry.author.role}): ${entry.message.content}\n`;
      return formattedPrompt;
    }, "");
    console.log("formattedMessages", formattedMessages);
    return formattedMessages;
  }

  if (promptType && promptType === "escalation") {
    const formattedConversation = await formatForOpenAIPrompt(conversationData);
    const response = JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You will be analyzing a customer service conversation to prepare a ticket for escalation to a specialized team. The escalation message should be structured as follows:

            Ticket Summary: Briefly summarize the core issue or request in no more than 100 words, highlighting key aspects that necessitate escalation.
            Reason for Escalation: Clearly specify why this ticket is being escalated. This could be due to:
              - Customer Sentiment: Indicate if the customer’s mood (e.g., frustration, urgency) warrants escalation for better handling.
              - Specialization Requirement: Explain if the issue falls outside the current team's expertise or is specific to another team's domain.
              - Technical Complexity: Describe if the issue's technical nature exceeds the current team's capabilities and requires more specialized knowledge or resources.
            Recommended Team for Escalation: Suggest the most appropriate team or department to handle the escalated issue, based on its nature and complexity. Teams available for escalation include:
              - Billing
              - Sales
              - Technical Support
              - Product
            Action Items and Pending Questions: List any immediate actions that the receiving team needs to undertake and any questions that remain unanswered, specifying who (the customer or the new team) should address them.
            `,
        },
        {
          role: "user",
          content: formattedConversation,
        },
      ],
      temperature: 0,
      max_tokens: 1024,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    return response;
  }

  if (promptType && promptType === "summarize") {
    const formattedConversation = await formatForOpenAIPrompt(conversationData);

    const response = JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You will be provided with a customer service conversation, and your task is to summarize the conversation as follows:\n    \n    -Overall summary of the ticket, this should be no longer than 100 words in length\n    -Action items (what needs to be done and who is doing it)\n    -If applicable, a list of questions that still need to be answered and by which party (end-user or agent)",
        },
        {
          role: "user",
          content: formattedConversation,
        },
      ],
      temperature: 0,
      max_tokens: 1024,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    return response;
  }

  if (promptType && promptType === "handoff") {
    const formattedConversation = await formatForOpenAIPrompt(conversationData);

    const response = JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You will be provided with a customer service conversation, and your task is to create a detailed handoff message for an agent who is going out of office. The handoff message should encompass the following sections:
          - Overall Summary of the Ticket: Briefly summarize the main issue or request, ensuring this section does not exceed 100 words.
          - Customer Sentiment: Provide a succinct overview of the customer’s current mood or feelings as inferred from the conversation, such as frustration, satisfaction, confusion, etc.
          - Actions Taken by Agent: Compile a list of steps already undertaken by the customer support agent in addressing the issue. This should include any troubleshooting, information provided, or steps taken to resolve the customer’s concerns.
          - Action Items: Identify any outstanding tasks, specifying what needs to be done next and who is responsible for each action (either the customer or the agent).
          - Pending Questions: If applicable, list any questions that still require answers, indicating whether the end-user or the agent needs to provide these answers.`,
        },
        {
          role: "user",
          content: formattedConversation,
        },
      ],
      temperature: 0,
      max_tokens: 1024,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    return response;
  }

  return "No prompt type provided.";
}
