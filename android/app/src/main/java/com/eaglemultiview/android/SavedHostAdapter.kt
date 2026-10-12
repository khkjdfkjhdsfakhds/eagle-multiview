package com.eaglemultiview.android

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.Filter
import android.widget.Filterable
import android.widget.TextView

/** Drop-down rows for the host field: pick fills the field, each row can be pinned or removed. */
class SavedHostAdapter(
    private val context: Context,
    private val onTogglePin: (SavedHost) -> Unit,
    private val onRemove: (SavedHost) -> Unit,
) : BaseAdapter(), Filterable {
    @Volatile
    private var book = SavedHostBook()
    private var shown: List<SavedHost> = emptyList()
    private var lastQuery: CharSequence? = null

    fun submit(book: SavedHostBook) {
        this.book = book
        shown = book.suggestions(lastQuery?.toString())
        if (shown.isEmpty()) notifyDataSetInvalidated() else notifyDataSetChanged()
    }

    override fun getCount(): Int = shown.size

    override fun getItem(position: Int): SavedHost = shown[position]

    override fun getItemId(position: Int): Long = position.toLong()

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
        val view = convertView ?: LayoutInflater.from(context).inflate(R.layout.item_saved_host, parent, false)
        val entry = getItem(position)
        val title = view.findViewById<TextView>(R.id.savedHostTitle)
        val subtitle = view.findViewById<TextView>(R.id.savedHostSubtitle)
        title.text = entry.label
        val detail = listOfNotNull(
            entry.endpoint.startUrl.takeIf { entry.name != null },
            context.getString(R.string.saved_host_pinned_badge).takeIf { entry.pinned },
        ).joinToString(" · ")
        subtitle.text = detail
        subtitle.visibility = if (detail.isEmpty()) View.GONE else View.VISIBLE
        // Not focusable, so a tap elsewhere on the row still picks the address.
        view.findViewById<Button>(R.id.savedHostPin).apply {
            isFocusable = false
            text = context.getString(if (entry.pinned) R.string.saved_host_unpin else R.string.saved_host_pin)
            contentDescription = "${text} ${entry.label}"
            setOnClickListener { onTogglePin(entry) }
        }
        view.findViewById<Button>(R.id.savedHostRemove).apply {
            isFocusable = false
            contentDescription = "${context.getString(R.string.saved_host_remove)} ${entry.label}"
            setOnClickListener { onRemove(entry) }
        }
        return view
    }

    override fun getFilter(): Filter = object : Filter() {
        override fun performFiltering(constraint: CharSequence?): FilterResults {
            val matches = book.suggestions(constraint?.toString())
            return FilterResults().apply {
                values = matches
                count = matches.size
            }
        }

        @Suppress("UNCHECKED_CAST")
        override fun publishResults(constraint: CharSequence?, results: FilterResults?) {
            lastQuery = constraint
            shown = (results?.values as? List<SavedHost>).orEmpty()
            if (shown.isEmpty()) notifyDataSetInvalidated() else notifyDataSetChanged()
        }

        override fun convertResultToString(resultValue: Any?): CharSequence =
            (resultValue as? SavedHost)?.endpoint?.startUrl ?: ""
    }
}
