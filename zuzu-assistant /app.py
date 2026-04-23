import streamlit as st
import io
import anthropic
import openpyxl
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

# ?? PAGE CONFIG ???????????????????????????????????????????????????????????????
st.set_page_config(
    page_title="Zuzu Assistant",
    page_icon="?",
    layout="wide",
    initial_sidebar_state="collapsed"
)

# ?? STYLING ???????????????????????????????????????????????????????????????????
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=Source+Code+Pro:wght@300;400&display=swap');

html, body, .stApp {
    background-color: #EFEDE1 !important;
    font-family: 'Playfair Display', serif;
    color: #231F20;
}

h1 { font-family: 'Playfair Display', serif; color: #412733; letter-spacing: 0.02em; }
h3 { font-family: 'Source Code Pro', monospace; font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: #565462; }

.stChatMessage { background-color: transparent !important; }
.stChatMessage p { font-family: 'Playfair Display', serif; font-size: 15px; line-height: 1.7; }

[data-testid="stChatInput"] textarea {
    background-color: #EFEDE1 !important;
    border: 1px solid #493933 !important;
    border-radius: 0 !important;
    font-family: 'Source Code Pro', monospace !important;
    font-size: 13px !important;
    color: #231F20 !important;
}

.stButton > button {
    background-color: #412733 !important;
    color: #EFEDE1 !important;
    border: none !important;
    border-radius: 0 !important;
    font-family: 'Source Code Pro', monospace !important;
    font-size: 11px !important;
    letter-spacing: 0.1em !important;
    text-transform: uppercase !important;
    padding: 8px 20px !important;
}

.stButton > button:hover { background-color: #493933 !important; }

.stSpinner > div { border-top-color: #412733 !important; }

div[data-testid="stStatusWidget"] { display: none; }

.file-count {
    font-family: 'Source Code Pro', monospace;
    font-size: 11px;
    color: #565462;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 2rem;
}

.pending-edit {
    background-color: #493933;
    color: #EFEDE1;
    padding: 12px 16px;
    font-family: 'Source Code Pro', monospace;
    font-size: 12px;
    margin: 8px 0;
}
</style>
""", unsafe_allow_html=True)


# ?? GOOGLE AUTH ???????????????????????????????????????????????????????????????
def get_credentials():
    creds = Credentials(
        token=None,
        refresh_token=st.secrets["google"]["refresh_token"],
        client_id=st.secrets["google"]["client_id"],
        client_secret=st.secrets["google"]["client_secret"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=[
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive"
        ]
    )
    creds.refresh(Request())
    return creds


@st.cache_resource
def get_services():
    creds = get_credentials()
    sheets = build("sheets", "v4", credentials=creds)
    drive = build("drive", "v3", credentials=creds)
    return sheets, drive


# ?? DRIVE HELPERS ?????????????????????????????????????????????????????????????
def list_files(drive):
    results = drive.files().list(
        q="mimeType='application/vnd.google-apps.spreadsheet' or mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'",
        fields="files(id, name, mimeType, modifiedTime)",
        corpora="user",
        pageSize=100,
        orderBy="modifiedTime desc"
    ).execute()
    return results.get("files", [])


def read_google_sheet(sheets, file_id, tab=None):
    if tab is None:
        info = sheets.spreadsheets().get(spreadsheetId=file_id).execute()
        tab = info["sheets"][0]["properties"]["title"]
    result = sheets.spreadsheets().values().get(
        spreadsheetId=file_id, range=tab
    ).execute()
    return result.get("values", []), tab


def get_tabs(sheets, file_id):
    info = sheets.spreadsheets().get(spreadsheetId=file_id).execute()
    return [s["properties"]["title"] for s in info["sheets"]]


def read_xlsx(drive, file_id):
    request = drive.files().get_media(fileId=file_id)
    data = io.BytesIO(request.execute())
    wb = openpyxl.load_workbook(data)
    return {
        name: [[str(c.value) if c.value is not None else "" for c in row]
               for row in wb[name].iter_rows()]
        for name in wb.sheetnames
    }


def write_google_sheet(sheets, file_id, tab, data):
    sheets.spreadsheets().values().update(
        spreadsheetId=file_id,
        range=tab,
        valueInputOption="USER_ENTERED",
        body={"values": data}
    ).execute()


def format_for_claude(data, max_rows=300):
    if not data:
        return "Empty sheet."
    return "\n".join(["\t".join(row) for row in data[:max_rows]])


# ?? CLAUDE ????????????????????????????????????????????????????????????????????
def ask_claude(user_message, files, sheets, drive):
    client = anthropic.Anthropic(api_key=st.secrets["anthropic"]["api_key"])

    file_list = "\n".join([
        f"- {f['name']} (ID: {f['id']}, type: {'Google Sheet' if 'spreadsheet' in f['mimeType'] else 'xlsx'})"
        for f in files
    ])

    system = f"""You are Zuzu Assistant ? a smart, warm planning assistant for Zoe McDaniel, founder of Zuzu Collective, a boutique wedding and event planning company in San Diego with the tagline "escape the mundane."

You have direct access to all of Zoe's planning spreadsheets in Google Drive. Here they are:

{file_list}

Zoe's current active clients:
- Berenice & Nello ? Fullerton Community Center, April 18, 2026 (VERY SOON)
- Becky & Russ ? Raven's Roost, Fort Bragg, July 5, 2026
- Chris & Lindsay ? South Coast Botanic Gardens, Sept 5, 2026 ("Ralph Lauren meets Nancy Meyers")
- Cody & Danny ? Ace Hotel Palm Springs, Sept 26, 2026 (elegant disco)
- Natalie & Josh ? November 15, 2026
- Ana & Nick ? Orcas Island, July 17, 2027

When Zoe asks about priorities, clients, vendors, timelines, or anything planning-related:
1. Read the relevant sheets using the read_sheet tool
2. Give her specific, actionable answers based on what you actually find
3. When she asks you to make edits, use write_sheet and summarize exactly what you changed

Be direct, warm, and efficient. Zoe is busy ? no fluff."""

    tools = [
        {
            "name": "read_sheet",
            "description": "Read a planning spreadsheet from Google Drive",
            "input_schema": {
                "type": "object",
                "properties": {
                    "file_id": {"type": "string", "description": "The file ID"},
                    "file_name": {"type": "string", "description": "The file name"},
                    "tab": {"type": "string", "description": "Tab/sheet name (optional ? reads first tab if omitted)"}
                },
                "required": ["file_id", "file_name"]
            }
        },
        {
            "name": "write_sheet",
            "description": "Write updated data to a Google Sheet. Only for Google Sheets, not xlsx.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "file_id": {"type": "string"},
                    "tab": {"type": "string"},
                    "data": {
                        "type": "array",
                        "items": {"type": "array"},
                        "description": "2D array of the full updated sheet content"
                    },
                    "summary": {"type": "string", "description": "Plain English summary of what changed"}
                },
                "required": ["file_id", "tab", "data", "summary"]
            }
        }
    ]

    messages = [{"role": "user", "content": user_message}]
    pending_writes = []

    while True:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=4096,
            system=system,
            tools=tools,
            messages=messages
        )

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn":
            text = next((b.text for b in response.content if hasattr(b, "text")), "")
            return text, pending_writes

        if response.stop_reason == "tool_use":
            tool_results = []

            for block in response.content:
                if block.type != "tool_use":
                    continue

                if block.name == "read_sheet":
                    fid = block.input["file_id"]
                    fname = block.input["file_name"]
                    tab = block.input.get("tab")
                    file_info = next((f for f in files if f["id"] == fid), None)

                    try:
                        if file_info and "openxmlformats" in file_info["mimeType"]:
                            sheets_data = read_xlsx(drive, fid)
                            tab = tab if tab in sheets_data else list(sheets_data.keys())[0]
                            data = sheets_data[tab]
                        else:
                            data, tab = read_google_sheet(sheets, fid, tab)

                        result = f"Contents of '{fname}' (tab: {tab}):\n\n{format_for_claude(data)}"
                    except Exception as e:
                        result = f"Error reading '{fname}': {str(e)}"

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result
                    })

                elif block.name == "write_sheet":
                    pending_writes.append({
                        "file_id": block.input["file_id"],
                        "tab": block.input["tab"],
                        "data": block.input["data"],
                        "summary": block.input["summary"]
                    })
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": f"Write queued: {block.input['summary']}"
                    })

            messages.append({"role": "user", "content": tool_results})


# ?? UI ????????????????????????????????????????????????????????????????????????
st.title("? Zuzu Assistant")

try:
    sheets_svc, drive_svc = get_services()
    if "files" not in st.session_state:
        with st.spinner("Connecting to your Drive..."):
            st.session_state.files = list_files(drive_svc)
    files = st.session_state.files
    st.markdown(f'<p class="file-count">{len(files)} planning files connected</p>', unsafe_allow_html=True)
except Exception as e:
    st.error(f"Could not connect to Google Drive: {e}")
    st.stop()

if "messages" not in st.session_state:
    st.session_state.messages = []
if "pending_writes" not in st.session_state:
    st.session_state.pending_writes = []

# Render chat history
for msg in st.session_state.messages:
    with st.chat_message(msg["role"]):
        st.markdown(msg["content"])

# Pending write confirmations
if st.session_state.pending_writes:
    for i, write in enumerate(st.session_state.pending_writes):
        st.markdown(f'<div class="pending-edit">? Proposed edit: {write["summary"]}</div>', unsafe_allow_html=True)
        col1, col2 = st.columns([1, 4])
        if col1.button("Confirm", key=f"confirm_{i}"):
            write_google_sheet(sheets_svc, write["file_id"], write["tab"], write["data"])
            st.session_state.pending_writes.pop(i)
            st.success("Sheet updated!")
            st.rerun()
        if col2.button("Cancel", key=f"cancel_{i}"):
            st.session_state.pending_writes.pop(i)
            st.rerun()

# Chat input
if prompt := st.chat_input("What do you need today?"):
    st.session_state.messages.append({"role": "user", "content": prompt})
    with st.chat_message("user"):
        st.markdown(prompt)

    with st.chat_message("assistant"):
        with st.spinner("Looking through your files..."):
            response_text, new_writes = ask_claude(
                prompt, files, sheets_svc, drive_svc
            )
        st.markdown(response_text)
        st.session_state.pending_writes.extend(new_writes)
        st.session_state.messages.append({"role": "assistant", "content": response_text})

    if new_writes:
        st.rerun()
